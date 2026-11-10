import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { createHttpApp, readBody } from '../src/http'
import { stableHash } from '../src/common'
import { scrubMetadata } from '../src/audit'
import type { WorkerBindings } from '../src/types'

const bindings = {
  APP_ENV: 'test', SESSION_SECRET: 'a-local-test-secret-of-at-least-32-characters',
  APP_ORIGINS: 'https://app.test', SIWE_DOMAIN: 'app.test', SIWE_URI: 'https://app.test',
  SIWE_CHAIN_ID: '5042', EMAIL_MODE: 'disabled',
} as WorkerBindings
const app = createHttpApp({ resolveAuth: () => null })
app.get('/api/probe', (c) => c.json({ ok: true }))
app.post('/api/probe', async (c) => c.json(await readBody(c, z.object({ value: z.string() }))))
const send = (method = 'GET', body?: BodyInit, headers: Record<string, string> = {}) =>
  app.request('https://app.test/api/probe', { method, body, headers }, bindings)

describe('Workers HTTP boundary', () => {
  test('serves JSON with security headers and a request id', async () => {
    const response = await send()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })
  test('rejects a cross-origin state change', async () => {
    const response = await send('POST', '{"value":"x"}', { Origin: 'https://evil.test', 'X-Requested-With': 'retempo', 'Content-Type': 'application/json' })
    expect(response.status).toBe(403)
  })
  test('requires the custom CSRF header even on an allowed origin', async () => {
    expect((await send('POST', '{"value":"x"}', { Origin: 'https://app.test', 'Content-Type': 'application/json' })).status).toBe(403)
  })
  test('validates JSON and returns structured field errors', async () => {
    const response = await send('POST', '{}', { Origin: 'https://app.test', 'X-Requested-With': 'retempo', 'Content-Type': 'application/json' })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: 'validation_failed', fields: { value: expect.any(String) as unknown } } })
  })
  test('limits actual body bytes even without a content-length header', async () => {
    const response = await send('POST', JSON.stringify({ value: 'a'.repeat(270000) }), { Origin: 'https://app.test', 'X-Requested-With': 'retempo', 'Content-Type': 'application/json' })
    expect(response.status).toBe(413)
  })
  test('rejects development email delivery in production', async () => {
    const response = await app.request('https://app.test/api/probe', {}, { ...bindings, APP_ENV: 'production', EMAIL_MODE: 'test' })
    expect(response.status).toBe(503)
  })
  test('returns 405 rather than hiding an existing endpoint behind a wrong method', async () => {
    const response = await send('DELETE', undefined, { Origin: 'https://app.test', 'X-Requested-With': 'retempo' })
    expect(response.status).toBe(405)
    expect(await response.json()).toMatchObject({ error: { code: 'method_not_allowed' } })
  })
  test('returns JSON for unknown API paths instead of an SPA document', async () => {
    const response = await app.request('https://app.test/api/does-not-exist', {}, bindings)
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})

test('semantic request hashes retain bigint precision and key order independence', async () => {
  expect(await stableHash({ a: 9007199254740993n, b: 2 })).toBe(await stableHash({ b: 2, a: '9007199254740993' }))
  expect(await stableHash({ a: '9007199254740993' })).not.toBe(await stableHash({ a: '9007199254740992' }))
})

test('audit metadata redacts nested credentials without losing public references', () => {
  expect(scrubMetadata({ password: 'never-store', nested: { signature: 'signed', txHash: '0xpublic' } }))
    .toEqual({ password: '[redacted]', nested: { signature: '[redacted]', txHash: '0xpublic' } })
})
