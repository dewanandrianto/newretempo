import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { getAddress } from 'viem'
import { createSiweMessage } from 'viem/siwe'
import { checkSiweMessage } from '../src/auth/siwe'
import { createTestEnv, registerClient, type TestClient, type TestEnv } from './helpers'

let env: TestEnv
beforeAll(async () => {
  env = await createTestEnv()
})
afterAll(async () => {
  await env.close()
})

type Challenge = { message: string; nonce: string }
type Me = { user: { id: string; wallets: { address: string }[] } }

// Throwaway test keys, generated in memory and never persisted.
const newAccount = () => privateKeyToAccount(generatePrivateKey())

async function challenge(client: TestClient, address: string, path = '/api/auth/siwe/nonce') {
  return client.post<Challenge>(path, { address })
}

describe('SIWE (EIP-4361) login', () => {
  test('a valid signed challenge creates a wallet account and session', async () => {
    const account = newAccount()
    const client = env.client()
    const { body } = await challenge(client, account.address)
    const signature = await account.signMessage({ message: body.message })
    const res = await client.post<Me>('/api/auth/siwe/verify', { message: body.message, signature })
    expect(res.status).toBe(200)
    expect(res.body.user.wallets[0].address).toBe(account.address.toLowerCase())
    expect((await client.get<Me>('/api/auth/me')).status).toBe(200)
    expect(client.cookieHeader()).toContain('retempo_session=')
  })

  test('the same wallet signs back into the same account', async () => {
    const account = newAccount()
    const first = env.client()
    const c1 = await challenge(first, account.address)
    const r1 = await first.post<Me>('/api/auth/siwe/verify', { message: c1.body.message, signature: await account.signMessage({ message: c1.body.message }) })
    const second = env.client()
    const c2 = await challenge(second, account.address)
    const r2 = await second.post<Me>('/api/auth/siwe/verify', { message: c2.body.message, signature: await account.signMessage({ message: c2.body.message }) })
    expect(r2.body.user.id).toBe(r1.body.user.id)
  })

  test('replaying a used message and signature is rejected', async () => {
    const account = newAccount()
    const client = env.client()
    const { body } = await challenge(client, account.address)
    const signature = await account.signMessage({ message: body.message })
    expect((await client.post('/api/auth/siwe/verify', { message: body.message, signature })).status).toBe(200)
    const replay = await env.client().post('/api/auth/siwe/verify', { message: body.message, signature })
    expect(replay.status).toBe(401)
  })

  test('nonces are random and unique', async () => {
    const account = newAccount()
    const a = await challenge(env.client(), account.address)
    const b = await challenge(env.client(), account.address)
    expect(a.body.nonce).not.toBe(b.body.nonce)
    expect(a.body.nonce).toMatch(/^[A-Za-z0-9]{24}$/)
  })

  test('a signature from a different wallet is rejected', async () => {
    const victim = newAccount()
    const attacker = newAccount()
    const client = env.client()
    const { body } = await challenge(client, victim.address)
    const signature = await attacker.signMessage({ message: body.message })
    expect((await client.post('/api/auth/siwe/verify', { message: body.message, signature })).status).toBe(401)
  })

  test('an address alone never authenticates', async () => {
    const res = await env.client().post('/api/auth/siwe/verify', { address: newAccount().address })
    expect(res.status).toBe(422)
  })

  test('messages the server never issued are rejected even when correctly signed', async () => {
    const account = newAccount()
    const message = createSiweMessage({
      address: getAddress(account.address),
      chainId: env.config.siwe.chainId,
      domain: env.config.siwe.domain,
      uri: env.config.siwe.uri,
      version: '1',
      nonce: 'selfmadenonce1234',
      issuedAt: new Date(),
      expirationTime: new Date(Date.now() + 60_000),
    })
    const signature = await account.signMessage({ message })
    expect((await env.client().post('/api/auth/siwe/verify', { message, signature })).status).toBe(401)
  })

  test('wrong domain, URI and chain ID are rejected', () => {
    const base = {
      address: getAddress(newAccount().address),
      version: '1' as const,
      nonce: 'abcdefgh12345678',
      issuedAt: new Date(),
      expirationTime: new Date(Date.now() + 60_000),
    }
    const good = { ...base, chainId: env.config.siwe.chainId, domain: env.config.siwe.domain, uri: env.config.siwe.uri }
    expect(() => checkSiweMessage(createSiweMessage(good), env.config, new Date())).not.toThrow()
    expect(() => checkSiweMessage(createSiweMessage({ ...good, domain: 'evil.test' }), env.config, new Date())).toThrow()
    expect(() => checkSiweMessage(createSiweMessage({ ...good, uri: 'https://evil.test' }), env.config, new Date())).toThrow()
    expect(() => checkSiweMessage(createSiweMessage({ ...good, chainId: 1 }), env.config, new Date())).toThrow()
  })

  test('issued-at and expiration are enforced', () => {
    const base = {
      address: getAddress(newAccount().address),
      version: '1' as const,
      nonce: 'abcdefgh12345678',
      chainId: env.config.siwe.chainId,
      domain: env.config.siwe.domain,
      uri: env.config.siwe.uri,
    }
    const now = new Date()
    const expired = createSiweMessage({ ...base, issuedAt: new Date(now.getTime() - 120_000), expirationTime: new Date(now.getTime() - 60_000) })
    expect(() => checkSiweMessage(expired, env.config, now)).toThrow()
    const future = createSiweMessage({ ...base, issuedAt: new Date(now.getTime() + 3_600_000), expirationTime: new Date(now.getTime() + 3_660_000) })
    expect(() => checkSiweMessage(future, env.config, now)).toThrow()
    const stale = createSiweMessage({ ...base, issuedAt: new Date(now.getTime() - 3_600_000), expirationTime: new Date(now.getTime() + 60_000) })
    expect(() => checkSiweMessage(stale, env.config, now)).toThrow()
  })

  test('an expired nonce cannot be redeemed', async () => {
    const account = newAccount()
    const client = env.client()
    const { body } = await challenge(client, account.address)
    await env.db`UPDATE siwe_nonces SET expires_at = now() - interval '1 second' WHERE nonce = ${body.nonce}`
    const signature = await account.signMessage({ message: body.message })
    expect((await client.post('/api/auth/siwe/verify', { message: body.message, signature })).status).toBe(401)
  })

  test('a message that sat past its time window is rejected using the server clock', async () => {
    const account = newAccount()
    const client = env.client()
    const { body } = await challenge(client, account.address)
    const signature = await account.signMessage({ message: body.message })
    env.now.value = new Date(Date.now() + 20 * 60_000)
    try {
      expect((await client.post('/api/auth/siwe/verify', { message: body.message, signature })).status).toBe(401)
    } finally {
      env.now.value = new Date()
    }
  })

  test('contract-wallet (EIP-1271) style signatures are explicitly unsupported', async () => {
    const account = newAccount()
    const client = env.client()
    const { body } = await challenge(client, account.address)
    const res = await client.post<{ error: { message: string } }>('/api/auth/siwe/verify', { message: body.message, signature: '0x' + 'ab'.repeat(100) })
    expect(res.status).toBe(401)
    expect(res.body.error.message).toContain('EIP-1271')
  })
})

describe('linking a wallet to an existing account', () => {
  test('requires a session and binds the challenge to that user', async () => {
    const account = newAccount()
    expect((await env.client().post('/api/auth/siwe/link/nonce', { address: account.address })).status).toBe(401)

    const alice = await registerClient(env)
    const bob = await registerClient(env)
    const { body } = await challenge(alice.client, account.address, '/api/auth/siwe/link/nonce')
    const signature = await account.signMessage({ message: body.message })

    const stolen = await bob.client.post('/api/auth/siwe/link/verify', { message: body.message, signature })
    expect(stolen.status).toBe(403)
  })

  test('links once, then the wallet logs into that account; another account cannot claim it', async () => {
    const account = newAccount()
    const alice = await registerClient(env)
    const { body } = await challenge(alice.client, account.address, '/api/auth/siwe/link/nonce')
    const signature = await account.signMessage({ message: body.message })
    const linked = await alice.client.post<Me>('/api/auth/siwe/link/verify', { message: body.message, signature })
    expect(linked.status).toBe(200)
    expect(linked.body.user.wallets[0].address).toBe(account.address.toLowerCase())

    const bob = await registerClient(env)
    const c2 = await challenge(bob.client, account.address, '/api/auth/siwe/link/nonce')
    const s2 = await account.signMessage({ message: c2.body.message })
    expect((await bob.client.post('/api/auth/siwe/link/verify', { message: c2.body.message, signature: s2 })).status).toBe(409)

    const fresh = env.client()
    const c3 = await challenge(fresh, account.address)
    const login = await fresh.post<Me>('/api/auth/siwe/verify', { message: c3.body.message, signature: await account.signMessage({ message: c3.body.message }) })
    expect(login.body.user.id).toBe(alice.userId)
  })
})
