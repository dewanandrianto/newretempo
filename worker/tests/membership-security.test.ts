import { env as rawEnv } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createWorkerApp } from '../src/index'
import { randomToken } from '../src/auth/crypto'
import type { WorkerBindings } from '../src/types'

const db = (rawEnv as unknown as WorkerBindings).DB
const app = createWorkerApp()
async function fixture() {
  let verificationLink = ''
  const bindings: WorkerBindings = { ...(rawEnv as unknown as WorkerBindings), APP_ENV: 'production', SESSION_SECRET: randomToken(), APP_ORIGINS: 'https://app.retempo.xyz', SIWE_DOMAIN: 'app.retempo.xyz', SIWE_URI: 'https://app.retempo.xyz', COOKIE_SECURE: 'true', EMAIL_MODE: 'delivery', REQUIRE_VERIFIED_EMAIL: 'true', MAILER: { fetch: async (request: Request) => { verificationLink = (await request.json<{ link: string }>()).link; return new Response('ok') } } as Fetcher }
  const request = (path: string, body?: unknown, cookie?: string) => app.request(`https://app.retempo.xyz/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: bindings.APP_ORIGINS, 'X-Requested-With': 'retempo', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings)
  const wallet = privateKeyToAccount(generatePrivateKey())
  const challenge = await (await request('auth/siwe/nonce', { address: wallet.address })).json<{ message: string }>()
  const login = await request('auth/siwe/verify', { message: challenge.message, signature: await wallet.signMessage({ message: challenge.message }) })
  expect(login.status).toBe(200)
  const ownerCookie = login.headers.get('set-cookie')!.split(';')[0]
  const organization = await request('orgs', { name: 'Security', slug: `security-${crypto.randomUUID().slice(0, 8)}`, industry: 'Software', country: 'Indonesia' }, ownerCookie)
  expect(organization.status).toBe(201)
  const org = await organization.json<{ id: string }>()
  expect((await request(`orgs/${org.id}`, undefined, ownerCookie)).status).toBe(200)
  expect((await request(`orgs/${org.id}/products`, { name: 'Wallet-only creator' }, ownerCookie)).status).toBe(201)
  const email = `colleague-${crypto.randomUUID()}@example.com`
  const registration = await request('auth/register', { email, password: 'Secure-membership-password-27!', name: 'Preclaim' })
  expect(registration.status).toBe(201)
  const account = await registration.json<{ user: { id: string; emailVerified: boolean } }>()
  expect(account.user.emailVerified).toBe(false)
  const cookie = registration.headers.get('set-cookie')!.split(';')[0]
  return { request, bindings, ownerCookie, org, email, cookie, userId: account.user.id, token: () => verificationLink.split('#')[1] }
}

test('production invitation denies an unverified preclaimed email and its tenant authority', async () => {
  const f = await fixture()
  const grant = await f.request(`orgs/${f.org.id}/members`, { email: f.email, role: 'admin' }, f.ownerCookie)
  const read = await f.request(`orgs/${f.org.id}`, undefined, f.cookie)
  const write = await f.request(`orgs/${f.org.id}/products`, { name: 'Exploit probe' }, f.cookie)
  console.log('production preclaim probe', JSON.stringify({ grant: grant.status, read: read.status, write: write.status }))
  expect(grant.status).toBe(404)
  expect(await db.prepare('SELECT id FROM memberships WHERE org_id=? AND user_id=?').bind(f.org.id, f.userId).first()).toBeNull()
  expect((await f.request(`orgs/${f.org.id}`, undefined, f.cookie)).status).toBe(404)
  expect((await f.request(`orgs/${f.org.id}/products`, { name: 'Denied' }, f.cookie)).status).toBe(404)
})

test.each(['owner', 'admin', 'member'])('legacy unverified %s membership cannot exercise authority even after linking and signing with a wallet', async role => {
  const f = await fixture()
  await db.prepare('INSERT INTO memberships (id,org_id,user_id,role) VALUES (?,?,?,?)').bind(crypto.randomUUID(), f.org.id, f.userId, role).run()
  const wallet = privateKeyToAccount(generatePrivateKey())
  await db.prepare("INSERT INTO wallets (id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,5042002,?,'siwe')").bind(crypto.randomUUID(), f.userId, wallet.address.toLowerCase(), new Date().toISOString()).run()
  const nonce = await (await f.request('auth/siwe/nonce', { address: wallet.address })).json<{ message: string }>()
  const login = await f.request('auth/siwe/verify', { message: nonce.message, signature: await wallet.signMessage({ message: nonce.message }) })
  const siweCookie = login.headers.get('set-cookie')!.split(';')[0]
  for (const cookie of [f.cookie, siweCookie]) {
    expect((await f.request(`orgs/${f.org.id}`, undefined, cookie)).status).toBe(404)
    expect((await f.request(`orgs/${f.org.id}/products`, { name: 'Denied' }, cookie)).status).toBe(404)
    expect(await (await f.request('orgs', undefined, cookie)).json()).toEqual([])
  }
})

test('verified email invitation retains password and linked SIWE member access with one concurrent grant and audit', async () => {
  const f = await fixture()
  expect((await f.request('auth/verify-email', { token: f.token() })).status).toBe(200)
  const grants = await Promise.all([1, 2].map(async () => f.request(`orgs/${f.org.id}/members`, { email: f.email, role: 'admin' }, f.ownerCookie)))
  expect(grants.map(r => r.status).sort()).toEqual([201, 409])
  expect((await db.prepare("SELECT id FROM audit_logs WHERE org_id=? AND action='member.added'").bind(f.org.id).all()).results).toHaveLength(1)
  expect((await f.request(`orgs/${f.org.id}`, undefined, f.cookie)).status).toBe(200)
  expect((await f.request(`orgs/${f.org.id}/products`, { name: 'Verified' }, f.cookie)).status).toBe(201)
  const wallet = privateKeyToAccount(generatePrivateKey())
  const nonce = await (await f.request('auth/siwe/link/nonce', { address: wallet.address }, f.cookie)).json<{ message: string }>()
  expect((await f.request('auth/siwe/link/verify', { message: nonce.message, signature: await wallet.signMessage({ message: nonce.message }) }, f.cookie)).status).toBe(200)
  const challenge = await (await f.request('auth/siwe/nonce', { address: wallet.address })).json<{ message: string }>()
  const login = await f.request('auth/siwe/verify', { message: challenge.message, signature: await wallet.signMessage({ message: challenge.message }) })
  expect((await f.request(`orgs/${f.org.id}`, undefined, login.headers.get('set-cookie')!.split(';')[0])).status).toBe(200)
})

test('verified member retains read access without acquiring admin write authority', async () => {
  const f = await fixture()
  expect((await f.request('auth/verify-email', { token: f.token() })).status).toBe(200)
  expect((await f.request(`orgs/${f.org.id}/members`, { email: f.email, role: 'member' }, f.ownerCookie)).status).toBe(201)
  expect((await f.request(`orgs/${f.org.id}`, undefined, f.cookie)).status).toBe(200)
  expect((await f.request(`orgs/${f.org.id}/products`, { name: 'Forbidden member write' }, f.cookie)).status).toBe(403)
})

test('unverified email cannot link a wallet even when verified-email policy is disabled', async () => {
  const f = await fixture()
  f.bindings.APP_ENV = 'test'
  f.bindings.REQUIRE_VERIFIED_EMAIL = 'false'
  const wallet = privateKeyToAccount(generatePrivateKey())
  const challenge = await (await f.request('auth/siwe/link/nonce', { address: wallet.address }, f.cookie)).json<{ message: string }>()
  expect((await f.request('auth/siwe/link/verify', { message: challenge.message, signature: await wallet.signMessage({ message: challenge.message }) }, f.cookie)).status).toBe(403)
  expect(await db.prepare("SELECT id FROM wallets WHERE purpose='login' AND address=?").bind(wallet.address.toLowerCase()).first()).toBeNull()
})

test('email recovery denies a legacy preclaim-linked wallet and subsequent admin writes', async () => {
  const f = await fixture()
  const attackerWallet = privateKeyToAccount(generatePrivateKey())
  // Seed the previously admitted binding to prove recovery protects existing accounts too.
  await db.prepare("INSERT INTO wallets (id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,5042002,?,'siwe')").bind(crypto.randomUUID(), f.userId, attackerWallet.address.toLowerCase(), new Date().toISOString()).run()
  expect((await f.request('auth/forgot-password', { email: f.email })).status).toBe(200)
  expect((await f.request('auth/reset-password', { token: f.token(), password: 'Recovered-owner-password-92!' })).status).toBe(200)
  expect((await f.request('auth/me', undefined, f.cookie)).status).toBe(401)
  expect((await db.prepare("SELECT id FROM wallets WHERE user_id=? AND purpose='login'").bind(f.userId).all()).results).toHaveLength(1)
  expect((await f.request(`orgs/${f.org.id}/members`, { email: f.email, role: 'admin' }, f.ownerCookie)).status).toBe(201)
  const nonce = await (await f.request('auth/siwe/nonce', { address: attackerWallet.address })).json<{ message: string }>()
  const login = await f.request('auth/siwe/verify', { message: nonce.message, signature: await attackerWallet.signMessage({ message: nonce.message }) })
  expect(login.status).toBe(403)
  expect(login.headers.get('set-cookie')).toBeNull()
  expect((await f.request(`orgs/${f.org.id}/products`, { name: 'Denied recovery attack' }, f.cookie)).status).toBe(401)
  expect(await db.prepare("SELECT verification_method FROM wallets WHERE user_id=? AND purpose='login'").bind(f.userId).first('verification_method')).toBeNull()
})
