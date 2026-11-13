import { env as rawEnv } from 'cloudflare:test'
import { expect, it } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { hmac } from '../src/auth/crypto'
import { createWorkerApp } from '../src/index'
import type { WorkerBindings } from '../src/types'

const env = rawEnv as unknown as WorkerBindings
const db = env.DB
const app = createWorkerApp()
const expiry = '2099-01-01T00:00:00.000Z'
let fixtureIndex = 0

async function addSession(userId: string, provider: 'privy' | 'password' = 'privy') {
  const sessionId = crypto.randomUUID()
  const token = crypto.randomUUID().replaceAll('-', '').repeat(2)
  await db.prepare(`INSERT INTO sessions(id,user_id,token_hash,auth_method,auth_provider,idle_expires_at,expires_at)
    VALUES (?,?,?,'password',?,?,?)`).bind(sessionId, userId, await hmac(env.SESSION_SECRET, token), provider === 'privy' ? 'privy' : null, expiry, expiry).run()
  return { sessionId, token }
}

async function setup(role: 'owner' | 'admin' = 'owner', provider: 'privy' | 'password' = 'privy') {
  const userId = crypto.randomUUID(), orgId = crypto.randomUUID()
  await db.prepare('INSERT INTO users(id,display_name) VALUES (?,?)').bind(userId, 'Synthetic merchant owner').run()
  await db.prepare('INSERT INTO privy_identities(privy_user_id,user_id) VALUES (?,?)').bind(`did:privy:${crypto.randomUUID()}`, userId).run()
  await db.prepare('INSERT INTO organizations(id,name,slug,industry,country,created_by) VALUES (?,?,?,?,?,?)').bind(orgId, 'Synthetic merchant', `m-${crypto.randomUUID().slice(0, 12)}`, 'software', 'ID', userId).run()
  await db.prepare('INSERT INTO memberships(id,org_id,user_id,role) VALUES (?,?,?,?)').bind(crypto.randomUUID(), orgId, userId, role).run()
  const session = await addSession(userId, provider)
  return { userId, orgId, ...session, ip: `198.51.${Math.floor(fixtureIndex / 250)}.${(fixtureIndex++ % 250) + 1}` }
}

async function request(f: { orgId: string; token: string; ip: string }, route: 'nonce' | 'verify', body: unknown, orgId = f.orgId, token = f.token) {
  return app.request(`https://app.test/api/orgs/${orgId}/merchant-wallet/${route}`, {
    method: 'POST',
    headers: { Origin: 'https://app.test', 'X-Requested-With': 'retempo', 'Content-Type': 'application/json', 'CF-Connecting-IP': f.ip, Cookie: `retempo_session=${token}` },
    body: JSON.stringify(body),
  }, env)
}

async function challenge(f: { orgId: string; token: string; ip: string }, wallet: ReturnType<typeof privateKeyToAccount>): Promise<{ message: string; expiresAt: string }> {
  const response = await request(f, 'nonce', { address: wallet.address })
  expect(response.status, await response.clone().text()).toBe(201)
  return response.json()
}

it('links the wallet and payout row to the same active Privy owner without creating or switching a session', async () => {
  const f = await setup()
  const wallet = privateKeyToAccount(generatePrivateKey())
  const beforeUsers = await db.prepare('SELECT count(*) AS n FROM users').first<{ n: number }>()
  const beforeSessions = await db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').bind(f.userId).first<{ n: number }>()
  const proof = await challenge(f, wallet)
  const signature = await wallet.signMessage({ message: proof.message })
  const response = await request(f, 'verify', { message: proof.message, signature })
  expect(response.status, await response.clone().text()).toBe(200)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(await response.json()).toMatchObject({ user: { id: f.userId }, session: { method: 'privy' } })
  const login = await db.prepare("SELECT user_id,verified_at,verification_method FROM wallets WHERE purpose='login' AND address=?").bind(wallet.address.toLowerCase()).first<{ user_id: string; verified_at: string; verification_method: string }>()
  const payout = await db.prepare("SELECT org_id,verified_at,verification_method FROM wallets WHERE purpose='payout' AND address=? AND chain_id=5042002").bind(wallet.address.toLowerCase()).first<{ org_id: string; verified_at: string; verification_method: string }>()
  expect(login).toMatchObject({ user_id: f.userId, verification_method: 'siwe' })
  expect(payout).toMatchObject({ org_id: f.orgId, verification_method: 'siwe' })
  expect(login?.verified_at).toBeTruthy()
  expect(payout?.verified_at).toBeTruthy()
  const afterUsers = await db.prepare('SELECT count(*) AS n FROM users').first<{ n: number }>()
  const afterSessions = await db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').bind(f.userId).first<{ n: number }>()
  expect(afterUsers?.n).toBe(beforeUsers?.n)
  expect(afterSessions?.n).toBe(beforeSessions?.n)
  const current = await app.request('https://app.test/api/auth/me', { headers: { Origin: 'https://app.test', Cookie: `retempo_session=${f.token}` } }, env)
  expect(current.status).toBe(200)
  expect(await current.json()).toMatchObject({ user: { id: f.userId }, memberships: [{ organization: { id: f.orgId } }] })
  const replay = await request(f, 'verify', { message: proof.message, signature })
  expect(replay.status).toBe(401)
})

it('does not treat an account login-wallet link as an organization payout verification', async () => {
  const f = await setup()
  const wallet = privateKeyToAccount(generatePrivateKey())
  await db.prepare("INSERT INTO wallets(id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,5042002,?,'siwe')")
    .bind(crypto.randomUUID(), f.userId, wallet.address.toLowerCase(), new Date().toISOString()).run()
  const statusUrl = `https://app.test/api/orgs/${f.orgId}/merchant-wallet/status?address=${encodeURIComponent(wallet.address)}`
  const before = await app.request(statusUrl, { headers: { Origin: 'https://app.test', Cookie: `retempo_session=${f.token}` } }, env)
  expect(before.status, await before.clone().text()).toBe(200)
  expect(await before.json()).toMatchObject({ verified: false, available: true })
  const proof = await challenge(f, wallet)
  const response = await request(f, 'verify', { message: proof.message, signature: await wallet.signMessage({ message: proof.message }) })
  expect(response.status, await response.clone().text()).toBe(200)
  const after = await app.request(statusUrl, { headers: { Origin: 'https://app.test', Cookie: `retempo_session=${f.token}` } }, env)
  expect(await after.json()).toMatchObject({ verified: true, available: true })
  expect(await db.prepare("SELECT count(*) AS n FROM wallets WHERE purpose='payout' AND org_id=? AND address=? AND chain_id=5042002").bind(f.orgId, wallet.address.toLowerCase()).first<{ n: number }>()).toMatchObject({ n: 1 })
})

it('rejects a signature from the wrong address without consuming the valid challenge', async () => {
  const f = await setup()
  const requested = privateKeyToAccount(generatePrivateKey())
  const wrong = privateKeyToAccount(generatePrivateKey())
  const proof = await challenge(f, requested)
  const bad = await request(f, 'verify', { message: proof.message, signature: await wrong.signMessage({ message: proof.message }) })
  expect(bad.status).toBe(401)
  expect(await db.prepare("SELECT count(*) AS n FROM wallets WHERE purpose='login' AND address=?").bind(requested.address.toLowerCase()).first<{n:number}>()).toMatchObject({ n: 0 })
  expect((await request(f, 'verify', { message: proof.message, signature: await requested.signMessage({ message: proof.message }) })).status).toBe(200)
})

it('rejects an expired challenge server-side even while its signed message is otherwise valid', async () => {
  const f = await setup()
  const wallet = privateKeyToAccount(generatePrivateKey())
  const proof = await challenge(f, wallet)
  const nonce = proof.message.match(/Nonce: (\S+)/)?.[1]
  expect(nonce).toBeTruthy()
  await db.prepare('UPDATE merchant_wallet_challenges SET expires_at=? WHERE nonce=?').bind('2000-01-01T00:00:00.000Z', nonce).run()
  const response = await request(f, 'verify', { message: proof.message, signature: await wallet.signMessage({ message: proof.message }) })
  expect(response.status).toBe(401)
  expect(await db.prepare("SELECT count(*) AS n FROM wallets WHERE purpose='login' AND address=?").bind(wallet.address.toLowerCase()).first<{n:number}>()).toMatchObject({ n: 0 })
})

it('does not write a payout row when the owner mutation is ineligible', async () => {
  const f = await setup()
  await db.prepare('UPDATE users SET email=?,email_verified_at=NULL WHERE id=?').bind(`unverified-${crypto.randomUUID()}@example.test`, f.userId).run()
  const wallet = privateKeyToAccount(generatePrivateKey())
  await db.prepare("INSERT INTO wallets(id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,5042002,?,'siwe')")
    .bind(crypto.randomUUID(), f.userId, wallet.address.toLowerCase(), new Date().toISOString()).run()
  const proof = await challenge(f, wallet)
  const response = await request(f, 'verify', { message: proof.message, signature: await wallet.signMessage({ message: proof.message }) })
  expect(response.status, await response.clone().text()).toBe(403)
  expect(await db.prepare("SELECT id FROM wallets WHERE purpose='payout' AND org_id=? AND address=? AND chain_id=5042002").bind(f.orgId, wallet.address.toLowerCase()).first()).toBeNull()
  expect((await db.prepare("SELECT count(*) AS n FROM audit_logs WHERE org_id=? AND action='merchant.wallet.verified'").bind(f.orgId).first<{ n: number }>())?.n).toBe(0)
})

it('binds the challenge to its exact session and organization', async () => {
  const f = await setup()
  const secondSession = await addSession(f.userId)
  const otherOrgId = crypto.randomUUID()
  await db.prepare('INSERT INTO organizations(id,name,slug,industry,country,created_by) VALUES (?,?,?,?,?,?)').bind(otherOrgId, 'Second synthetic workspace', `w-${crypto.randomUUID().slice(0, 12)}`, 'software', 'ID', f.userId).run()
  await db.prepare("INSERT INTO memberships(id,org_id,user_id,role) VALUES (?,?,?,'owner')").bind(crypto.randomUUID(), otherOrgId, f.userId).run()
  const wallet = privateKeyToAccount(generatePrivateKey())
  const proof = await challenge(f, wallet)
  const signature = await wallet.signMessage({ message: proof.message })
  expect((await request(f, 'verify', { message: proof.message, signature }, otherOrgId)).status).toBe(401)
  expect((await request(f, 'verify', { message: proof.message, signature }, f.orgId, secondSession.token)).status).toBe(401)
  expect((await db.prepare("SELECT count(*) AS n FROM wallets WHERE purpose='login' AND address=?").bind(wallet.address.toLowerCase()).first<{n:number}>())?.n).toBe(0)
  expect((await request(f, 'verify', { message: proof.message, signature })).status).toBe(200)
})

it('rejects missing, non-Privy, and non-owner sessions before issuing a challenge', async () => {
  const ownerPassword = await setup('owner', 'password')
  const wallet = privateKeyToAccount(generatePrivateKey())
  const passwordResponse = await request(ownerPassword, 'nonce', { address: wallet.address })
  expect(passwordResponse.status).toBe(403)
  const admin = await setup('admin', 'privy')
  expect((await request(admin, 'nonce', { address: wallet.address })).status).toBe(403)
  const anonymous = await app.request(`https://app.test/api/orgs/${admin.orgId}/merchant-wallet/nonce`, {
    method: 'POST', headers: { Origin: 'https://app.test', 'X-Requested-With': 'retempo', 'Content-Type': 'application/json', 'CF-Connecting-IP': admin.ip }, body: JSON.stringify({ address: wallet.address }),
  }, env)
  expect(anonymous.status).toBe(401)
})

it('refuses addresses already used by another login account, a customer, or another merchant workspace', async () => {
  const f = await setup()
  const otherUser = crypto.randomUUID()
  await db.prepare('INSERT INTO users(id,display_name) VALUES (?,?)').bind(otherUser, 'Synthetic unrelated account').run()
  const loginAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase()
  await db.prepare("INSERT INTO wallets(id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,5042002,?,'siwe')").bind(crypto.randomUUID(), otherUser, loginAddress, new Date().toISOString()).run()
  expect((await request(f, 'nonce', { address: loginAddress })).status).toBe(409)

  const customerAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase()
  const customerId = crypto.randomUUID()
  await db.prepare("INSERT INTO customers(id,org_id,name,email) VALUES (?,?,?,?)").bind(customerId, f.orgId, 'Synthetic customer', 'synthetic@example.test').run()
  await db.prepare("INSERT INTO wallets(id,purpose,org_id,customer_id,address,chain_id) VALUES (?,'customer',?,?,?,5042002)").bind(crypto.randomUUID(), f.orgId, customerId, customerAddress).run()
  expect((await request(f, 'nonce', { address: customerAddress })).status).toBe(409)

  const payoutAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase()
  const otherOrgId = crypto.randomUUID()
  await db.prepare('INSERT INTO organizations(id,name,slug,industry,country,created_by) VALUES (?,?,?,?,?,?)').bind(otherOrgId, 'Other synthetic merchant', `x-${crypto.randomUUID().slice(0, 12)}`, 'software', 'ID', otherUser).run()
  await db.prepare("INSERT INTO memberships(id,org_id,user_id,role) VALUES (?,?,?,'owner')").bind(crypto.randomUUID(), otherOrgId, otherUser).run()
  await db.prepare("INSERT INTO wallets(id,purpose,org_id,address,chain_id) VALUES (?,'payout',?,?,5042002)").bind(crypto.randomUUID(), otherOrgId, payoutAddress).run()
  expect((await request(f, 'nonce', { address: payoutAddress })).status).toBe(409)

  const wrongChainAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase()
  await db.prepare("INSERT INTO wallets(id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,1,?,'siwe')")
    .bind(crypto.randomUUID(), f.userId, wrongChainAddress, new Date().toISOString()).run()
  expect((await request(f, 'nonce', { address: wrongChainAddress })).status).toBe(409)
})

it('atomically refuses merchant linking if the address becomes a customer wallet after the precheck', async () => {
  const f = await setup()
  const wallet = privateKeyToAccount(generatePrivateKey())
  const proof = await challenge(f, wallet)
  const signature = await wallet.signMessage({ message: proof.message })
  let injectCustomer = true
  const raceDb = {
    prepare(sql: string) { return env.DB.prepare(sql) },
    async batch(statements: Parameters<typeof env.DB.batch>[0]) {
      if (injectCustomer) {
        injectCustomer = false
        const customerId = crypto.randomUUID()
        await env.DB.prepare('INSERT INTO customers(id,org_id,name,email) VALUES (?,?,?,?)').bind(customerId, f.orgId, 'Synthetic concurrent customer', `race-${customerId}@example.test`).run()
        await env.DB.prepare("INSERT INTO wallets(id,purpose,org_id,customer_id,address,chain_id) VALUES (?,'customer',?,?,?,5042002)").bind(crypto.randomUUID(), f.orgId, customerId, wallet.address.toLowerCase()).run()
      }
      return env.DB.batch(statements)
    },
  } as unknown as WorkerBindings['DB']
  const response = await app.request(`https://app.test/api/orgs/${f.orgId}/merchant-wallet/verify`, {
    method: 'POST',
    headers: { Origin: 'https://app.test', 'X-Requested-With': 'retempo', 'Content-Type': 'application/json', 'CF-Connecting-IP': f.ip, Cookie: `retempo_session=${f.token}` },
    body: JSON.stringify({ message: proof.message, signature }),
  }, { ...env, DB: raceDb })
  expect(response.status, await response.clone().text()).toBe(409)
  expect(await db.prepare("SELECT id FROM wallets WHERE purpose='customer' AND address=?").bind(wallet.address.toLowerCase()).first()).toBeTruthy()
  expect(await db.prepare("SELECT id FROM wallets WHERE purpose='payout' AND org_id=? AND address=?").bind(f.orgId, wallet.address.toLowerCase()).first()).toBeNull()
  expect(await db.prepare("SELECT id FROM wallets WHERE purpose='login' AND address=?").bind(wallet.address.toLowerCase()).first()).toBeNull()
  expect((await db.prepare("SELECT count(*) AS n FROM audit_logs WHERE org_id=? AND action='merchant.wallet.verified'").bind(f.orgId).first<{ n: number }>())?.n).toBe(0)
})
