import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createWorkerApp } from '../src/index'
import { randomToken } from '../src/auth/crypto'
import type { WorkerBindings } from '../src/types'

// Fresh ephemeral secret in memory, never a reusable production credential.
const bindings: WorkerBindings = { ...env, APP_ENV: 'production', SESSION_SECRET: randomToken(), APP_ORIGINS: 'https://app.retempo.xyz', SIWE_DOMAIN: 'app.retempo.xyz', SIWE_URI: 'https://app.retempo.xyz', SIWE_CHAIN_ID: '5042002', COOKIE_SECURE: 'true', EMAIL_MODE: 'disabled', REQUIRE_VERIFIED_EMAIL: 'true' } as WorkerBindings

test('production does not mint development API tokens for the unimplemented API-key authentication feature', async () => {
  const app = createWorkerApp()
  const request = async (path: string, body: unknown, cookie?: string) => app.request(`https://app.retempo.xyz/api/${path}`, { method: 'POST', headers: { Origin: bindings.APP_ORIGINS, 'X-Requested-With': 'retempo', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }, bindings)
  const account = privateKeyToAccount(generatePrivateKey())
  const { message } = await (await request('auth/siwe/nonce', { address: account.address })).json<{ message: string }>()
  const login = await request('auth/siwe/verify', { message, signature: await account.signMessage({ message }) })
  expect(login.status).toBe(200)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]
  const org = await request('orgs', { name: 'Production fixture', slug: crypto.randomUUID(), industry: 'Software', country: 'US' }, cookie)
  expect(org.status).toBe(201)
  const { id } = await org.json<{ id: string }>()
  const response = await request(`orgs/${id}/api-keys`, { name: 'No fake production credential', scopes: ['read'] }, cookie)
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: { code: 'api_key_auth_unavailable' } })
  expect(await bindings.DB.prepare('SELECT count(*) FROM api_keys WHERE org_id=?').bind(id).first('count(*)')).toBe(0)
})
