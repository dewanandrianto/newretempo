import { env } from 'cloudflare:test'
import { Hono } from 'hono'
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { registerAuthRoutes } from '../src/auth/routes'
import { resolveAuth } from '../src/auth/sessions'
import { consumeRateLimit } from '../src/auth/rateLimits'
import { HttpError } from '../src/errors'
import type { WorkerBindings, WorkerContext } from '../src/types'

const db = (env as unknown as WorkerBindings).DB
const mail: { to: string; link: string; kind: string }[] = []
const bindings = (extra: Partial<WorkerBindings> = {}) => ({ ...env, APP_ENV: 'test', EMAIL_MODE: 'test', SESSION_SECRET: 'auth-test-secret-minimum-thirty-two-characters', APP_ORIGINS: 'https://app.test', SIWE_DOMAIN: 'app.test', SIWE_URI: 'https://app.test', SIWE_CHAIN_ID: '5042002', MAILER: { fetch: async (r: Request) => { mail.push(await r.json()); return new Response('ok') } }, ...extra }) as WorkerBindings
function app() {
  const a = new Hono<WorkerContext>()
  a.use('*', async (c, next) => { c.set('ip', '192.0.2.5'); c.set('requestId', crypto.randomUUID()); c.set('auth', await resolveAuth(c)); await next() })
  a.onError((e, c) => e instanceof HttpError ? c.json({ error: { code: e.code, message: e.message } }, e.status as 400) : c.json({ error: { message: e.message } }, 500))
  registerAuthRoutes(a)
  return a
}
async function req(path: string, body?: unknown, cookie?: string, extra: Partial<WorkerBindings> = {}) {
  return app().request(`https://app.test/api/auth/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings(extra))
}
const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]

describe('Workers authentication API', () => {
  it('registers, verifies via mail, rotates sessions, resets and logs out', async () => {
    const email = 'account@example.test', password = 'safe unique password 8492'
    const registered = await req('register', { email, password, name: 'Alice' })
    expect(await registered.clone().json()).toMatchObject({ user: { email, displayName: 'Alice', emailVerified: false, wallets: [] }, memberships: [], verificationEmailSent: true, session: { method: 'password' } })
    expect(registered.status).toBe(201)
    expect(registered.headers.get('set-cookie')).toContain('HttpOnly')
    const oldCookie = cookieOf(registered)
    const verification = mail.at(-1)!.link.split('#')[1]
    expect(await registered.text()).not.toContain(verification)
    expect((await req('verify-email', { token: verification })).status).toBe(200)
    expect((await req('verify-email', { token: verification })).status).toBe(401)
    expect(await (await req('me', undefined, oldCookie)).json()).toMatchObject({ user: { emailVerified: true } })
    const login = await req('login', { email, password }, oldCookie)
    expect(login.status).toBe(200)
    const currentCookie = cookieOf(login)
    expect(currentCookie).not.toBe(oldCookie)
    expect((await req('me', undefined, oldCookie)).status).toBe(401)
    expect((await req('forgot-password', { email })).status).toBe(200)
    const reset = mail.at(-1)!.link.split('#')[1]
    expect((await req('reset-password', { token: reset, password: 'different strong password 993' })).status).toBe(200)
    expect((await req('me', undefined, currentCookie)).status).toBe(401)
    expect((await req('reset-password', { token: reset, password })).status).toBe(401)
    expect((await req('login', { email, password })).status).toBe(401)
    const fresh = await req('login', { email, password: 'different strong password 993' })
    expect(fresh.status).toBe(200)
    expect((await req('logout', {}, cookieOf(fresh))).status).toBe(200)
    expect((await req('me', undefined, cookieOf(fresh))).status).toBe(401)
  })
  it('fails closed without a delivery adapter', async () => {
    const response = await req('register', { email: 'closed@example.test', name: 'Test', password: 'a strong password 923' }, undefined, { MAILER: undefined })
    expect(response.status).toBe(503)
    expect(await db.prepare('SELECT id FROM users WHERE email=?').bind('closed@example.test').first()).toBeNull()
  })
  it('consumes signed SIWE nonces once even in parallel and rejects wrong chains and expiry', async () => {
    const account = privateKeyToAccount(`0x${'12'.repeat(32)}`)
    const issue = async () => await (await req('siwe/nonce', { address: account.address })).json<{ message: string; nonce: string }>()
    const challenge = await issue()
    const signature = await account.signMessage({ message: challenge.message })
    const results = await Promise.all([req('siwe/verify', { message: challenge.message, signature }), req('siwe/verify', { message: challenge.message, signature })])
    expect(results.map(r => r.status).sort()).toEqual([200, 401])
    expect((await req('siwe/verify', { message: challenge.message, signature })).status).toBe(401)
    const wrong = await issue(), wrongMessage = wrong.message.replace('Chain ID: 5042002', 'Chain ID: 1')
    expect((await req('siwe/verify', { message: wrongMessage, signature: await account.signMessage({ message: wrongMessage }) })).status).toBe(401)
    const expired = await issue()
    await db.prepare('UPDATE siwe_nonces SET expires_at=? WHERE nonce=?').bind('2000-01-01T00:00:00.000Z', expired.nonce).run()
    expect((await req('siwe/verify', { message: expired.message, signature: await account.signMessage({ message: expired.message }) })).status).toBe(401)
  })
  it('links only to the challenge owner and prevents duplicate wallet ownership', async () => {
    const owner = privateKeyToAccount(`0x${'23'.repeat(32)}`)
    const other = privateKeyToAccount(`0x${'34'.repeat(32)}`)
    const linked = privateKeyToAccount(`0x${'45'.repeat(32)}`)
    async function login(account: typeof owner) {
      const challenge = await (await req('siwe/nonce', { address: account.address })).json() as {message:string}
      const response = await req('siwe/verify', { message: challenge.message, signature: await account.signMessage({message:challenge.message}) })
      expect(response.status).toBe(200)
      return cookieOf(response)
    }
    const ownerCookie = await login(owner), otherCookie = await login(other)
    const challenge = await (await req('siwe/link/nonce', {address:linked.address}, ownerCookie)).json() as {message:string}
    const body = {message:challenge.message,signature:await linked.signMessage({message:challenge.message})}
    expect((await req('siwe/link/verify', body, otherCookie)).status).toBe(401)
    const success = await req('siwe/link/verify', body, ownerCookie)
    expect(success.status).toBe(200)
    expect(await success.json()).toMatchObject({user:{wallets:expect.arrayContaining([{address:linked.address.toLowerCase(),chainId:5042002}]) as unknown}})
    expect((await req('siwe/link/verify', body, ownerCookie)).status).toBe(401)
    const duplicate = await (await req('siwe/link/nonce', {address:linked.address}, otherCookie)).json() as {message:string}
    expect((await req('siwe/link/verify', {message:duplicate.message,signature:await linked.signMessage({message:duplicate.message})}, otherCookie)).status).toBe(409)
    expect((await req('siwe/link/nonce', {address:linked.address})).status).toBe(401)
  })
  it('uses secure host-only production cookies even when COOKIE_SECURE is false', async () => {
    const response = await req('register', { email: 'production@example.test', name: 'Production', password: 'a strong password for production' }, undefined, { APP_ENV: 'production', EMAIL_MODE: undefined, COOKIE_SECURE: 'false' })
    expect(response.status).toBe(201)
    const cookie = response.headers.get('set-cookie')!
    expect(cookie).toContain('__Host-retempo_session=')
    expect(cookie).toContain('; Secure')
    expect(cookie).not.toContain('Domain=')
    expect((await req('me', undefined, cookieOf(response), { APP_ENV: 'production' })).status).toBe(200)
    expect((await req('register', { email: 'test-in-prod@example.test', name: 'No', password: 'a strong password for production' }, undefined, { APP_ENV: 'production', EMAIL_MODE: 'test' })).status).toBe(503)
  })
  it('atomically consumes reset tokens in parallel and rejects expired tokens', async () => {
    const email = 'parallel-reset@example.test', password = 'safe old password 999'
    const registration = await req('register', { email, password, name: 'Parallel' })
    expect(registration.status).toBe(201)
    const cookie = cookieOf(registration)
    await req('forgot-password', { email })
    const token = mail.at(-1)!.link.split('#')[1]
    const results = await Promise.all([
      req('reset-password', { token, password: 'parallel new password A' }),
      req('reset-password', { token, password: 'parallel new password B' }),
    ])
    expect(results.map(r => r.status).sort()).toEqual([200, 401])
    expect((await req('me', undefined, cookie)).status).toBe(401)
    await req('forgot-password', { email })
    const expired = mail.at(-1)!.link.split('#')[1]
    await db.prepare("UPDATE email_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=(SELECT id FROM users WHERE email=?)").bind(email).run()
    expect((await req('reset-password', { token: expired, password: 'not accepted password' })).status).toBe(401)
  })
  it('expires idle and absolute sessions and blocks disabled users', async () => {
    const email = 'session-expiry@example.test', password = 'safe session password 999'
    const registration = await req('register', { email, password, name: 'Sessions' })
    expect(registration.status).toBe(201)
    const user = await db.prepare('SELECT id FROM users WHERE email=?').bind(email).first<{id:string}>()
    await db.prepare("UPDATE sessions SET idle_expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?").bind(user!.id).run()
    expect((await req('me', undefined, cookieOf(registration))).status).toBe(401)
    const login = await req('login', { email, password })
    expect(login.status).toBe(200)
    await db.prepare("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?").bind(user!.id).run()
    expect((await req('me', undefined, cookieOf(login))).status).toBe(401)
    const fresh = await req('login', { email, password })
    await db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(user!.id).run()
    expect((await req('me', undefined, cookieOf(fresh))).status).toBe(401)
    expect((await req('login', { email, password })).status).toBe(401)
  })
  it('does not disclose mail delivery failures or leave undelivered tokens usable', async () => {
    const response = await req('register', { email: 'delivery-failure@example.test', name: 'Failure', password: 'a safe failed email password' }, undefined, { MAILER: { fetch: () => Promise.reject(new Error('provider failed with secret body')) } as unknown as Fetcher })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ verificationEmailSent: false })
    const pending = await db.prepare("SELECT count(*) AS count FROM email_tokens t JOIN users u ON u.id=t.user_id WHERE u.email=? AND t.used_at IS NULL").bind('delivery-failure@example.test').first('count')
    expect(pending).toBe(0)
    const missing = await req('forgot-password', { email: 'unknown-email@example.test' })
    expect(await missing.json()).toEqual({ ok: true })
  })
  it('enforces atomic rate limits across independently created request contexts', async () => {
    const key = crypto.randomUUID()
    const results = await Promise.all(Array.from({ length: 12 }, () => consumeRateLimit(db, key, 3, 60000).then(() => true, () => false)))
    expect(results.filter(Boolean)).toHaveLength(3)
    expect(await db.prepare('SELECT count FROM rate_limits WHERE key=?').bind(key).first('count')).toBe(12)
  })
})
