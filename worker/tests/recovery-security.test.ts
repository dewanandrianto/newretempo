import { env as rawEnv } from 'cloudflare:test'
import { Hono } from 'hono'
import { expect, test } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createWorkerApp } from '../src/index'
import { randomToken } from '../src/auth/crypto'
import { resolveAuth, establishSession } from '../src/auth/sessions'
import { verifyChallenge } from '../src/auth/siwe'
import { linkWalletToUser, loginWithWallet } from '../src/auth/walletAuth'
import { HttpError } from '../src/errors'
import type { WorkerBindings, WorkerContext } from '../src/types'

const db = (rawEnv as unknown as WorkerBindings).DB
const password = 'Recovery-owner-strong-password-92!'
const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]
let fixtureIndex = 0
async function fixture() {
  const ip = `192.0.2.${++fixtureIndex}`
  let token = ''
  const bindings: WorkerBindings = { ...(rawEnv as unknown as WorkerBindings), APP_ENV: 'production', SESSION_SECRET: randomToken(), APP_ORIGINS: 'https://app.retempo.xyz', SIWE_DOMAIN: 'app.retempo.xyz', SIWE_URI: 'https://app.retempo.xyz', COOKIE_SECURE: 'true', EMAIL_MODE: 'delivery', REQUIRE_VERIFIED_EMAIL: 'true', MAILER: { fetch: async (r: Request) => { token = (await r.json<{link:string}>()).link.split('#')[1]; return new Response('ok') } } as Fetcher }
  const app = createWorkerApp()
  const request = (path: string, body?: unknown, cookie?: string) => app.request(`https://app.retempo.xyz/api/auth/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'CF-Connecting-IP': ip, Origin: bindings.APP_ORIGINS, 'X-Requested-With': 'retempo', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings)
  const email = `recovery-${crypto.randomUUID()}@example.com`
  const registered = await request('register', { email, password, name: 'Recovery' })
  expect(registered.status).toBe(201)
  const user = (await registered.json<{user:{id:string}}>()).user.id
  const cookie = cookieOf(registered)
  expect((await request('verify-email', { token })).status).toBe(200)
  const wallet = privateKeyToAccount(generatePrivateKey())
  const sign = async (purpose: 'link'|'login', cookie?: string) => {
    const response = await request(purpose === 'link' ? 'siwe/link/nonce' : 'siwe/nonce', { address: wallet.address }, cookie)
    expect(response.status).toBe(200)
    const { message } = await response.json<{message:string}>()
    return { message, signature: await wallet.signMessage({ message }) }
  }
  const link = async (cookie: string) => request('siwe/link/verify', await sign('link', cookie), cookie)
  const reset = async (expectedStatus = 200) => {
    expect((await request('forgot-password', { email })).status).toBe(200)
    const resetToken = token
    expect((await request('reset-password', { token: resetToken, password })).status).toBe(expectedStatus)
    return resetToken
  }
  const fresh = async () => { const r = await request('login', { email, password }); expect(r.status).toBe(200); return cookieOf(r) }
  return { request, bindings, user, cookie, wallet, sign, link, reset, fresh }
}

test('recovered owner sees no revoked login wallets, relinks with fresh signature, and replay cannot revoke the new link', async () => {
  const f = await fixture()
  expect((await f.link(f.cookie)).status).toBe(200)
  const id = await db.prepare("SELECT id FROM wallets WHERE purpose='login' AND user_id=?").bind(f.user).first('id')
  const resetToken = await f.reset()
  const fresh = await f.fresh()
  expect(await (await f.request('me', undefined, fresh)).json()).toMatchObject({ user: { id: f.user, wallets: [] } })
  for (const path of ['wallet/chain/snapshot', 'customer/chain/snapshot', 'customer/chain/snapshot/pages']) {
    const response = await createWorkerApp().request(`https://app.retempo.xyz/api/${path}`, { headers: { Cookie: fresh, Origin: f.bindings.APP_ORIGINS } }, f.bindings)
    expect(response.status).toBe(403)
  }
  expect((await f.request('siwe/verify', await f.sign('login'))).status).toBe(403)
  expect((await f.link(fresh)).status).toBe(200)
  expect(await db.prepare("SELECT id FROM wallets WHERE purpose='login' AND user_id=?").bind(f.user).first('id')).toBe(id)
  expect((await f.request('reset-password', { token: resetToken, password: 'Another-strong-password-93!' })).status).toBe(401)
  const login = await f.request('siwe/verify', await f.sign('login'))
  expect(login.status).toBe(200)
  expect(await login.json()).toMatchObject({ user: { id: f.user, wallets: [{ address: f.wallet.address.toLowerCase(), chainId: 5042002 }] } })
})

test('revoked binding remains reserved against another authenticated wallet-only account', async () => {
  const f = await fixture()
  expect((await f.link(f.cookie)).status).toBe(200)
  await f.reset()
  const outsider = privateKeyToAccount(generatePrivateKey())
  const challenge = await (await f.request('siwe/nonce', { address: outsider.address })).json<{message:string}>()
  const login = await f.request('siwe/verify', { message: challenge.message, signature: await outsider.signMessage({ message: challenge.message }) })
  expect(login.status).toBe(200)
  expect((await f.link(cookieOf(login))).status).toBe(409)
  expect(await db.prepare("SELECT user_id FROM wallets WHERE purpose='login' AND address=?").bind(f.wallet.address.toLowerCase()).first('user_id')).toBe(f.user)
  expect(await db.prepare("SELECT verification_method FROM wallets WHERE purpose='login' AND address=?").bind(f.wallet.address.toLowerCase()).first('verification_method')).toBeNull()
  expect((await f.link(await f.fresh())).status).toBe(200)
})

test('reset invalidates pending link challenges even under a fresh recovered session', async () => {
  const f = await fixture()
  const pending = await f.sign('link', f.cookie)
  await f.reset()
  expect((await f.request('siwe/link/verify', pending, await f.fresh())).status).toBe(401)
  expect((await f.link(await f.fresh())).status).toBe(200)
})

// The test gate pauses after genuine auth/signature verification, then executes a
// real reset before the production mutation. Every SQL operation uses workerd D1.
test.each([false, true])('stale authenticated link mutation cannot resurrect login access (existing=%s)', async existing => {
  const f = await fixture()
  if (existing) expect((await f.link(f.cookie)).status).toBe(200)
  const signed = await f.sign('link', f.cookie)
  const gate = new Hono<WorkerContext>()
  gate.onError((e, c) => e instanceof HttpError ? c.json({ error: e.code }, e.status as 400) : c.json({ error: e.message }, 500))
  gate.post('/race', async c => {
    c.set('ip', '192.0.2.10'); c.set('requestId', crypto.randomUUID())
    const auth = await resolveAuth(c)
    expect(auth).not.toBeNull()
    c.set('auth', auth)
    const wallet = await verifyChallenge(c, { ...signed, purpose: 'link', userId: f.user })
    await f.reset()
    await linkWalletToUser(c, wallet, f.user)
    return c.json({ ok: true })
  })
  const r = await gate.request('https://app.retempo.xyz/race', { method: 'POST', headers: { Cookie: f.cookie } }, f.bindings)
  expect([403, 409]).toContain(r.status)
  const rows = await db.prepare("SELECT verification_method FROM wallets WHERE purpose='login' AND user_id=? AND verification_method='siwe'").bind(f.user).all()
  expect(rows.results).toHaveLength(0)
  expect((await f.link(await f.fresh())).status).toBe(200)
})

test.each([false, true])('SIWE session establishment paused across reset cannot create a new attacker session (relinked=%s)', async relinked => {
  const f = await fixture()
  expect((await f.link(f.cookie)).status).toBe(200)
  const signed = await f.sign('login')
  const gate = new Hono<WorkerContext>()
  gate.onError((e, c) => e instanceof HttpError ? c.json({ error: e.code }, e.status as 400) : c.json({ error: e.message }, 500))
  gate.post('/race', async c => {
    c.set('ip', '192.0.2.10'); c.set('requestId', crypto.randomUUID())
    const wallet = await verifyChallenge(c, { ...signed, purpose: 'login' })
    const user = await loginWithWallet(c, wallet)
    await f.reset()
    if (relinked) expect((await f.link(await f.fresh())).status).toBe(200)
    await establishSession(c, user)
    return c.json({ ok: true })
  })
  const r = await gate.request('https://app.retempo.xyz/race', { method: 'POST' }, f.bindings)
  expect(r.status).toBe(403)
  expect(r.headers.get('set-cookie')).toBeNull()
  expect((await db.prepare('SELECT id FROM sessions WHERE user_id=? AND revoked_at IS NULL').bind(f.user).all()).results).toHaveLength(relinked ? 1 : 0)
})

test('reset revokes every login wallet but leaves customer and payout records byte-for-byte unchanged', async () => {
  const f = await fixture()
  expect((await f.link(f.cookie)).status).toBe(200)
  const second = privateKeyToAccount(generatePrivateKey())
  const nonce = await (await f.request('siwe/link/nonce', { address: second.address }, f.cookie)).json<{message:string}>()
  expect((await f.request('siwe/link/verify', { message: nonce.message, signature: await second.signMessage({ message: nonce.message }) }, f.cookie)).status).toBe(200)
  const org = crypto.randomUUID(), customer = crypto.randomUUID()
  await db.batch([
    db.prepare("INSERT INTO organizations(id,name,slug,industry,country,created_by) VALUES (?,'Recovery',?,'Software','Indonesia',?)").bind(org, `recovery-${org.slice(0, 8)}`, f.user),
    db.prepare("INSERT INTO customers(id,org_id,name,email) VALUES (?,?,'Customer','customer@example.com')").bind(customer, org),
    db.prepare("INSERT INTO wallets(id,purpose,org_id,address,chain_id,label) VALUES (?,'payout',?,?,5042002,'Keep payout')").bind(crypto.randomUUID(), org, f.wallet.address.toLowerCase()),
    db.prepare("INSERT INTO wallets(id,purpose,org_id,customer_id,address,chain_id,label) VALUES (?,'customer',?,?,?,5042002,'Keep customer')").bind(crypto.randomUUID(), org, customer, f.wallet.address.toLowerCase()),
  ])
  const financial = () => db.prepare("SELECT * FROM wallets WHERE purpose IN ('payout','customer') AND org_id=? ORDER BY id").bind(org).all()
  const before = (await financial()).results
  expect(before).toHaveLength(2)
  await f.reset()
  expect((await financial()).results).toEqual(before)
  expect((await db.prepare("SELECT id FROM wallets WHERE user_id=? AND purpose='login' AND verification_method IS NULL").bind(f.user).all()).results).toHaveLength(2)
  expect((await f.request('siwe/verify', await f.sign('login'))).status).toBe(403)
  const challenge = await (await f.request('siwe/nonce', { address: second.address })).json<{message:string}>()
  expect((await f.request('siwe/verify', { message: challenge.message, signature: await second.signMessage({ message: challenge.message }) })).status).toBe(403)
})

test('a D1 wallet-revocation failure rolls back password, sessions and reset token consumption together', async () => {
  const f = await fixture()
  expect((await f.link(f.cookie)).status).toBe(200)
  const before = await db.prepare('SELECT password_hash,email_verified_at FROM users WHERE id=?').bind(f.user).first()
  // Test-only fault injection; never applied to migrations or a remote database.
  await db.prepare("CREATE TRIGGER recovery_test_abort BEFORE UPDATE OF verification_method ON wallets WHEN NEW.verification_method IS NULL BEGIN SELECT RAISE(ABORT,'recovery test fault'); END").run()
  let token: string
  try { token = await f.reset(500) } finally { await db.prepare('DROP TRIGGER recovery_test_abort').run() }
  expect(await db.prepare('SELECT password_hash,email_verified_at FROM users WHERE id=?').bind(f.user).first()).toEqual(before)
  expect((await f.request('me', undefined, f.cookie)).status).toBe(200)
  expect(await db.prepare("SELECT verification_method FROM wallets WHERE purpose='login' AND user_id=?").bind(f.user).first('verification_method')).toBe('siwe')
  expect(await db.prepare("SELECT used_at FROM email_tokens WHERE user_id=? AND purpose='reset_password'").bind(f.user).first('used_at')).toBeNull()
  expect((await f.request('reset-password', { token, password })).status).toBe(200)
})

test('wallet-only onboarding and linking remain functional with email delivery disabled', async () => {
  const f = await fixture()
  f.bindings.EMAIL_MODE = 'disabled'
  f.bindings.MAILER = undefined
  const login = await f.request('siwe/verify', await f.sign('login'))
  expect(login.status).toBe(200)
  expect(await login.clone().json()).toMatchObject({ user: { email: null } })
  const cookie = cookieOf(login), second = privateKeyToAccount(generatePrivateKey())
  const challenge = await (await f.request('siwe/link/nonce', { address: second.address }, cookie)).json<{message:string}>()
  expect((await f.request('siwe/link/verify', { message: challenge.message, signature: await second.signMessage({ message: challenge.message }) }, cookie)).status).toBe(200)
  expect((await f.request('forgot-password', { email: 'disabled@example.com' })).status).toBe(503)
})

test('wallet linking rolls back if its mandatory audit fails', async () => {
  const f = await fixture()
  await db.prepare("CREATE TRIGGER recovery_link_audit_abort BEFORE INSERT ON audit_logs WHEN NEW.action='wallet.linked' BEGIN SELECT RAISE(ABORT,'recovery link audit test fault'); END").run()
  try {
    expect((await f.link(f.cookie)).status).toBe(500)
    expect(await db.prepare("SELECT id FROM wallets WHERE purpose='login' AND user_id=?").bind(f.user).first()).toBeNull()
  } finally { await db.prepare('DROP TRIGGER recovery_link_audit_abort').run() }
})
