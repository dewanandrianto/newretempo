import { env as rawEnv } from 'cloudflare:test'
import { Hono } from 'hono'
import { expect, test } from 'vitest'
import { createWorkerApp } from '../src/index'
import { authenticatePassword } from '../src/auth/service'
import { establishSession } from '../src/auth/sessions'
import { randomToken } from '../src/auth/crypto'
import { HttpError } from '../src/errors'
import type { WorkerBindings, WorkerContext } from '../src/types'

const oldPassword = 'Session-fence-old-password-92!'
const newPassword = 'Session-fence-new-password-94!'
let sequence = 0
function fixture() {
  const mail: {kind:string;link:string}[] = []
  const ip = `192.0.2.${150 + ++sequence}`
  const bindings: WorkerBindings = { ...(rawEnv as unknown as WorkerBindings), APP_ENV: 'production', SESSION_SECRET: randomToken(), APP_ORIGINS: 'https://app.retempo.xyz', SIWE_DOMAIN: 'app.retempo.xyz', SIWE_URI: 'https://app.retempo.xyz', COOKIE_SECURE: 'true', EMAIL_MODE: 'delivery', REQUIRE_VERIFIED_EMAIL: 'true', MAILER: { fetch: async (r: Request) => { mail.push(await r.json<{kind:string;link:string}>()); return new Response('ok') } } as Fetcher }
  const app = createWorkerApp(), email = `session-fence-${crypto.randomUUID()}@example.com`
  const request = (path: string, body?: unknown, cookie?: string) => app.request(`https://app.retempo.xyz/api/auth/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'CF-Connecting-IP': ip, Origin: bindings.APP_ORIGINS, 'X-Requested-With': 'retempo', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings)
  const user = () => bindings.DB.prepare('SELECT id,password_hash,status,email_verified_at FROM users WHERE email=?').bind(email).first<{id:string;password_hash:string;status:string;email_verified_at:string|null}>()
  const sessions = () => bindings.DB.prepare('SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email=? ORDER BY s.id').bind(email).all()
  const reset = async () => {
    expect((await request('forgot-password', { email })).status).toBe(200)
    const token = [...mail].reverse().find(m => m.kind === 'reset_password')!.link.split('#')[1]
    expect((await request('reset-password', { token, password: newPassword })).status).toBe(200)
    return token
  }
  return { bindings, request, email, mail, user, sessions, reset }
}
const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]

test('password proof captured before reset cannot issue or rotate a session, even when retried after fresh login', async () => {
  const f = fixture()
  expect((await f.request('register', { email: f.email, password: oldPassword, name: 'Fence' })).status).toBe(201)
  const gate = new Hono<WorkerContext>()
  gate.onError((e, c) => e instanceof HttpError ? c.json({ error: e.code }, e.status as 400) : c.json({ error: 'unexpected' }, 500))
  let authenticated: Awaited<ReturnType<typeof authenticatePassword>>
  gate.post('/race', async c => {
    c.set('ip', '192.0.2.240'); c.set('requestId', crypto.randomUUID())
    authenticated = await authenticatePassword(c, { email: f.email, password: oldPassword })
    return c.json({ ok: true })
  })
  expect((await gate.request('https://app.retempo.xyz/race', { method: 'POST' }, f.bindings)).status).toBe(200)
  {
    const resetToken = await f.reset()
    const admission = new Hono<WorkerContext>()
    admission.onError((e, ctx) => e instanceof HttpError ? ctx.json({ error: e.code }, e.status as 400) : ctx.json({ error: 'unexpected' }, 500))
    admission.post('/mint', async ctx => {
      ctx.set('ip', '192.0.2.241'); ctx.set('requestId', crypto.randomUUID())
      await establishSession(ctx, authenticated)
      return ctx.json({ ok: true })
    })
    const beforeFresh = (await f.sessions()).results
    const deniedBeforeFresh = await admission.request('https://app.retempo.xyz/mint', { method: 'POST' }, f.bindings)
    expect(deniedBeforeFresh.status).toBe(403)
    expect(deniedBeforeFresh.headers.get('set-cookie')).toBeNull()
    expect((await f.request('me')).status).toBe(401)
    expect((await f.sessions()).results).toEqual(beforeFresh)
    expect(beforeFresh.filter(row => row.revoked_at === null)).toHaveLength(0)
    const fresh = await f.request('login', { email: f.email, password: newPassword })
    expect(fresh.status).toBe(200)
    const freshCookie = cookieOf(fresh)
    const before = (await f.sessions()).results
    const userBefore = await f.user()
    for (let attempt = 0; attempt < 2; attempt++) {
      const denied = await admission.request('https://app.retempo.xyz/mint', { method: 'POST', headers: { Cookie: freshCookie } }, f.bindings)
      expect(denied.status).toBe(403)
      expect(denied.headers.get('set-cookie')).toBeNull()
      expect((await f.sessions()).results).toEqual(before)
      expect(JSON.stringify(await f.user()) === JSON.stringify(userBefore)).toBe(true)
    }
    expect((await f.request('me', undefined, freshCookie)).status).toBe(200)
    expect((await f.request('login', { email: f.email, password: oldPassword })).status).toBe(401)
    expect((await f.request('reset-password', { token: resetToken, password: oldPassword })).status).toBe(401)
  }
})

test('registration paused in real mail delivery cannot issue a session after password reset', async () => {
  const f = fixture()
  const delivery = f.bindings.MAILER!
  let afterReset: unknown
  f.bindings.MAILER = { fetch: async (r: Request) => {
    const message = await r.clone().json<{kind:string}>()
    const response = await delivery.fetch(r)
    if (message.kind === 'verify_email') {
      await f.reset()
      afterReset = await f.user()
      expect((await f.sessions()).results).toHaveLength(0)
    }
    return response
  } } as Fetcher
  const registered = await f.request('register', { email: f.email, password: oldPassword, name: 'Fence registration' })
  expect(registered.status).toBe(403)
  expect(registered.headers.get('set-cookie')).toBeNull()
  expect((await f.sessions()).results).toHaveLength(0)
  expect(JSON.stringify(await f.user()) === JSON.stringify(afterReset)).toBe(true)
  expect((await f.request('login', { email: f.email, password: oldPassword })).status).toBe(401)
  const fresh = await f.request('login', { email: f.email, password: newPassword })
  expect(fresh.status).toBe(200)
  expect((await f.request('me', undefined, cookieOf(fresh))).status).toBe(200)
})

test('invalid null password proof cannot admit a wallet-only user or rotate an existing session', async () => {
  const f = fixture(), userId = crypto.randomUUID()
  await f.bindings.DB.prepare("INSERT INTO users (id,display_name) VALUES (?,'Wallet-only fixture')").bind(userId).run()
  const registered = await f.request('register', { email: f.email, password: oldPassword, name: 'Unaffected' })
  expect(registered.status).toBe(201)
  const before = (await f.bindings.DB.prepare('SELECT * FROM sessions ORDER BY id').all()).results
  const gate = new Hono<WorkerContext>()
  gate.onError((e, c) => e instanceof HttpError ? c.json({ error: e.code }, e.status as 400) : c.json({ error: 'unexpected' }, 500))
  gate.post('/invalid', async c => {
    c.set('ip', '192.0.2.242'); c.set('requestId', crypto.randomUUID())
    // @ts-expect-error A password proof must carry a non-null authenticated hash.
    await establishSession(c, { method: 'password', userId, passwordHash: null })
    return c.json({ ok: true })
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    const denied = await gate.request('https://app.retempo.xyz/invalid', { method: 'POST', headers: { Cookie: cookieOf(registered) } }, f.bindings)
    expect(denied.status).toBe(403)
    expect(denied.headers.get('set-cookie')).toBeNull()
    expect((await f.bindings.DB.prepare('SELECT * FROM sessions ORDER BY id').all()).results).toEqual(before)
    expect(await f.bindings.DB.prepare('SELECT status FROM users WHERE id=?').bind(userId).first('status')).toBe('active')
  }
  expect((await f.request('me', undefined, cookieOf(registered))).status).toBe(200)
})

test('a password authentication paused before insertion cannot mint after account disabling', async () => {
  const f = fixture()
  const registered = await f.request('register', { email: f.email, password: oldPassword, name: 'Disabled login' })
  expect(registered.status).toBe(201)
  const gate = new Hono<WorkerContext>()
  gate.onError((e, c) => e instanceof HttpError ? c.json({ error: e.code }, e.status as 400) : c.json({ error: 'unexpected' }, 500))
  let before: unknown
  gate.post('/disabled', async c => {
    c.set('ip', '192.0.2.243'); c.set('requestId', crypto.randomUUID())
    const proof = await authenticatePassword(c, { email: f.email, password: oldPassword })
    await f.bindings.DB.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(proof.userId).run()
    before = await f.user()
    await establishSession(c, proof)
    return c.json({ ok: true })
  })
  const sessionsBefore = (await f.sessions()).results
  const denied = await gate.request('https://app.retempo.xyz/disabled', { method: 'POST', headers: { Cookie: cookieOf(registered) } }, f.bindings)
  expect(denied.status).toBe(403)
  expect(denied.headers.get('set-cookie')).toBeNull()
  expect((await f.sessions()).results).toEqual(sessionsBefore)
  expect(JSON.stringify(await f.user()) === JSON.stringify(before)).toBe(true)
  expect((await f.request('me', undefined, cookieOf(registered))).status).toBe(401)
})

test('registration mail await also fences account status without disclosing its credential', async () => {
  const f = fixture(), delivery = f.bindings.MAILER!
  f.bindings.MAILER = { fetch: async (r: Request) => {
    const response = await delivery.fetch(r)
    await f.bindings.DB.prepare("UPDATE users SET status='disabled' WHERE email=?").bind(f.email).run()
    return response
  } } as Fetcher
  const denied = await f.request('register', { email: f.email, password: oldPassword, name: 'Disabled registration' })
  expect(denied.status).toBe(403)
  expect(denied.headers.get('set-cookie')).toBeNull()
  expect((await f.sessions()).results).toHaveLength(0)
  const user = (await f.user())!
  expect(user.status).toBe('disabled')
  const body = await denied.text()
  const audit = JSON.stringify((await f.bindings.DB.prepare('SELECT metadata FROM audit_logs WHERE actor_user_id=?').bind(user.id).all()).results)
  for (const value of [user.password_hash, oldPassword, 'passwordHash', 'password_hash']) {
    expect(body.includes(value)).toBe(false)
    expect(audit.includes(value)).toBe(false)
  }
})
