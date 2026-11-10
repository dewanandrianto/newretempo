import { env } from 'cloudflare:test'
import { describe, expect, test } from 'vitest'
import { createWorkerApp } from '../src/index'
import { randomToken } from '../src/auth/crypto'
import type { WorkerBindings } from '../src/types'

const production = (): WorkerBindings => ({
  ...env, APP_ENV: 'production',
  SESSION_SECRET: randomToken(),
  APP_ORIGINS: 'https://app.retempo.xyz', SIWE_DOMAIN: 'app.retempo.xyz',
  SIWE_URI: 'https://app.retempo.xyz', SIWE_CHAIN_ID: '5042002', EMAIL_MODE: 'disabled',
  COOKIE_SECURE: 'true', REQUIRE_VERIFIED_EMAIL: 'true',
} as WorkerBindings)
const health = (extra: Record<string, unknown> = {}) => createWorkerApp().request('https://app.retempo.xyz/api/health', {}, { ...production(), ...extra })

describe('production configuration fails closed before authentication or D1', () => {
  test('accepts a complete HTTPS wallet-only configuration', async () => {
    expect((await health()).status).toBe(200)
  })
  test.each([
    ['local secret', { SESSION_SECRET: 'retempo-local-test-pepper-not-for-production-00000000' }],
    ['repeated secret', { SESSION_SECRET: 'a'.repeat(64) }],
    ['patterned fixture secret', { SESSION_SECRET: '0123456789abcdef'.repeat(4) }],
    ['origin credentials', { APP_ORIGINS: 'https://user:pass@app.retempo.xyz' }],
    ['origin path', { APP_ORIGINS: 'https://app.retempo.xyz/path' }],
    ['loopback origin', { APP_ORIGINS: 'https://127.0.0.1' }],
    ['empty origin entry', { APP_ORIGINS: 'https://app.retempo.xyz,' }],
    ['mismatched SIWE domain', { SIWE_DOMAIN: 'evil.example' }],
    ['untrusted SIWE URI', { SIWE_URI: 'https://evil.example' }],
    ['unsafe SIWE chain', { SIWE_CHAIN_ID: '9007199254740993' }],
    ['wrong chain', { SIWE_CHAIN_ID: '1' }],
    ['unknown email mode', { EMAIL_MODE: 'typo' }],
    ['test email mode', { EMAIL_MODE: 'test' }],
    ['implicit email mode', { EMAIL_MODE: undefined }],
    ['delivery without adapter', { EMAIL_MODE: 'delivery', MAILER: undefined }],
    ['insecure cookie', { COOKIE_SECURE: 'false' }],
    ['misspelled cookie', { COOKIE_SECURE: 'TRUE' }],
    ['verification policy typo', { REQUIRE_VERIFIED_EMAIL: 'tru' }],
    ['disabled verification policy', { REQUIRE_VERIFIED_EMAIL: 'false' }],
    ['unbounded lifetime', { SESSION_TTL_HOURS: '999999' }],
    ['invalid idle timeout', { SESSION_IDLE_HOURS: 'NaN' }],
    ['idle beyond lifetime', { SESSION_TTL_HOURS: '1', SESSION_IDLE_HOURS: '2' }],
  ])('rejects %s', async (_label, extra) => {
    const response = await health(extra)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'configuration_error' } })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
