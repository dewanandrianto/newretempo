import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createWorkerApp } from '../src/index'
import { randomToken } from '../src/auth/crypto'
import type { WorkerBindings } from '../src/types'

const app = createWorkerApp()
const bindings = env as unknown as WorkerBindings
const headers = { Origin: 'https://app.test', 'X-Requested-With': 'retempo', 'Content-Type': 'application/json' }

test('does not mistake JSONP or a substring media type for JSON', async () => {
  for (const media of ['application/jsonp', 'text/application/json', 'text/plain; application/json']) {
    const response = await app.request('https://app.test/api/auth/siwe/nonce', { method: 'POST', headers: { ...headers, 'Content-Type': media }, body: JSON.stringify({ address: '0x' + '12'.repeat(20) }) }, bindings)
    expect(response.status).toBe(415)
  }
})

test('production API cookies, success/error headers and replay protection pass the real middleware', async () => {
  const production: WorkerBindings = { ...bindings, APP_ENV: 'production', SESSION_SECRET: randomToken(), APP_ORIGINS: 'https://app.retempo.xyz', SIWE_DOMAIN: 'app.retempo.xyz', SIWE_URI: 'https://app.retempo.xyz', COOKIE_SECURE: 'true', EMAIL_MODE: 'disabled', REQUIRE_VERIFIED_EMAIL: 'true' }
  const request = async (path: string, body?: unknown, cookie?: string, origin = production.APP_ORIGINS) => app.request(`https://app.retempo.xyz/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, production)
  const account = privateKeyToAccount(generatePrivateKey())
  const challenge = await (await request('auth/siwe/nonce', { address: account.address })).json<{ message: string }>()
  const signed = { message: challenge.message, signature: await account.signMessage({ message: challenge.message }) }
  const login = await request('auth/siwe/verify', signed)
  expect(login.status).toBe(200)
  const setCookie = login.headers.get('set-cookie')!
  expect(setCookie).toMatch(/^__Host-retempo_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/)
  const cookie = setCookie.split(';')[0]
  const me = await request('auth/me', undefined, cookie)
  expect(me.status).toBe(200)
  const denied = await request('auth/logout', {}, cookie, 'https://attacker.example')
  expect(denied.status).toBe(403)
  expect((await request('auth/me', undefined, cookie)).status).toBe(200)
  expect((await request('auth/siwe/verify', signed)).status).toBe(401)
  const preflight = await app.request('https://app.retempo.xyz/api/auth/logout', { method: 'OPTIONS', headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-requested-with' } }, production)
  expect(preflight.headers.get('access-control-allow-origin')).toBeNull()
  for (const response of [login, me, denied, preflight]) {
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'")
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000')
  }
  expect((await request('auth/logout', {}, cookie)).headers.get('set-cookie')).toContain('Max-Age=0')
  expect((await request('auth/me', undefined, cookie)).status).toBe(401)
})
