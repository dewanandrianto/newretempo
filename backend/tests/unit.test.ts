import { describe, expect, test } from 'bun:test'
import { MoneyError, formatBaseUnits, parseBaseUnits, parseUsdc, safeJsonStringify, sumBaseUnits } from '@shared/money'
import { can, outranks } from '../src/auth/permissions'
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../src/auth/passwords'
import { ConfigError, loadConfig } from '../src/config'
import { RateLimiter } from '../src/http/rateLimit'
import { HttpError } from '../src/http/errors'
import { scrubMetadata } from '../src/services/audit'
import { hmacHex, randomNonce, randomToken, safeEqual } from '../src/security/crypto'
import { originAllowed } from '../src/http/app'

describe('money (integer base units, 6 decimals)', () => {
  test('parses decimals exactly with no float error', () => {
    expect(parseUsdc('0.1')).toBe(100_000n)
    expect(parseUsdc('0.000001')).toBe(1n)
    expect(parseUsdc('49')).toBe(49_000_000n)
    expect(parseUsdc('1234567.123456')).toBe(1_234_567_123_456n)
  })

  test('rejects more than 6 decimals, signs, exponents and junk', () => {
    for (const bad of ['0.0000001', '-1', '1e6', '1,000', '', '.5', '1.', 'abc', '99999999999999999999']) {
      expect(() => parseUsdc(bad)).toThrow(MoneyError)
    }
  })

  test('formats base units without floats', () => {
    expect(formatBaseUnits(49_000_000n)).toBe('49.00')
    expect(formatBaseUnits('1')).toBe('0.000001')
    expect(formatBaseUnits('9007199254740993')).toBe('9007199254.740993')
    expect(formatBaseUnits(1_500_000n)).toBe('1.50')
  })

  test('wire strings reject overflow and non-integers', () => {
    expect(parseBaseUnits('9223372036854775807')).toBe(9_223_372_036_854_775_807n)
    expect(() => parseBaseUnits('9223372036854775808')).toThrow(MoneyError)
    expect(() => parseBaseUnits('1.5')).toThrow(MoneyError)
    expect(() => parseBaseUnits('-5')).toThrow(MoneyError)
  })

  test('sums exactly and refuses overflow', () => {
    expect(sumBaseUnits([1n, 2n, 3n])).toBe(6n)
    expect(() => sumBaseUnits([9_223_372_036_854_775_807n, 1n])).toThrow(MoneyError)
  })

  test('bigint JSON serialization is safe and lossless', () => {
    expect(safeJsonStringify({ amount: 9007199254740993n })).toBe('{"amount":"9007199254740993"}')
  })
})

describe('permissions', () => {
  test('members read and write customers/invoices only', () => {
    expect(can('member', 'customers:write')).toBe(true)
    expect(can('member', 'invoices:write')).toBe(true)
    expect(can('member', 'catalog:write')).toBe(false)
    expect(can('member', 'escrows:write')).toBe(false)
    expect(can('member', 'api_keys:manage')).toBe(false)
  })
  test('admins manage everything operational; ranking prevents privilege escalation', () => {
    expect(can('admin', 'escrows:write')).toBe(true)
    expect(outranks('admin', 'owner')).toBe(false)
    expect(outranks('owner', 'admin')).toBe(true)
    expect(outranks('admin', 'admin')).toBe(false)
  })
})

describe('passwords', () => {
  test('hashes with Argon2id and verifies', async () => {
    const hash = await hashPassword('a long enough password')
    expect(hash.startsWith('$argon2id$')).toBe(true)
    expect(await verifyPassword('a long enough password', hash)).toBe(true)
    expect(await verifyPassword('wrong password here', hash)).toBe(false)
  })
  test('policy rejects short and trivial passwords', () => {
    expect(() => assertPasswordPolicy('short')).toThrow(HttpError)
    expect(() => assertPasswordPolicy('password123')).toThrow(HttpError)
    expect(() => assertPasswordPolicy('a perfectly fine passphrase')).not.toThrow()
  })
})

describe('rate limiter', () => {
  test('blocks after the limit and recovers after the window', () => {
    let t = 0
    const limiter = new RateLimiter(() => t)
    for (let i = 0; i < 3; i++) limiter.consume('k', 3, 1000)
    expect(() => limiter.consume('k', 3, 1000)).toThrow(HttpError)
    limiter.consume('other', 3, 1000)
    t = 1500
    expect(() => limiter.consume('k', 3, 1000)).not.toThrow()
  })
})

describe('crypto helpers', () => {
  test('tokens are random and nonces are alphanumeric >= 8', () => {
    expect(randomToken()).not.toBe(randomToken())
    const nonce = randomNonce(24)
    expect(nonce).toMatch(/^[A-Za-z0-9]{24}$/)
  })
  test('hmac is keyed and safeEqual is constant-shape', () => {
    expect(hmacHex('a', 'x')).not.toBe(hmacHex('b', 'x'))
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('audit metadata scrubbing', () => {
  test('redacts credential-like keys, keeps public data', () => {
    const out = scrubMetadata({ password: 'x', sessionToken: 'y', apiSecret: 'z', txHash: '0xabc', nested: { signature: 's', ok: 1 } })
    expect(out).toEqual({ password: '[redacted]', sessionToken: '[redacted]', apiSecret: '[redacted]', txHash: '0xabc', nested: { signature: '[redacted]', ok: 1 } })
  })
})

describe('configuration', () => {
  const base = { DATABASE_URL: 'postgres://x', SESSION_SECRET: 'a'.repeat(40) }
  test('rejects a short session secret', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(ConfigError)
  })
  test('production forces dev email logging off, secure cookies and verified email', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'production',
      EMAIL_MODE: 'log',
      SIWE_DOMAIN: 'retempo.xyz',
      SIWE_URI: 'https://retempo.xyz',
      APP_ORIGINS: 'https://retempo.xyz',
    })
    expect(cfg.emailMode).toBe('disabled')
    expect(cfg.cookieSecure).toBe(true)
    expect(cfg.requireVerifiedEmail).toBe(true)
  })
  test('production requires SIWE and https origins', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', SIWE_DOMAIN: 'a', SIWE_URI: 'http://a', APP_ORIGINS: 'http://a' })).toThrow(ConfigError)
  })
  test('origin allowlist', () => {
    const dev = loadConfig({ ...base, APP_ORIGINS: 'https://app.test' })
    expect(originAllowed('https://app.test', dev)).toBe(true)
    expect(originAllowed('https://evil.test', dev)).toBe(false)
    expect(originAllowed('https://abc.preview.studio.arc.io', dev)).toBe(true)
    const prod = loadConfig({ ...base, NODE_ENV: 'production', SIWE_DOMAIN: 'a.io', SIWE_URI: 'https://a.io', APP_ORIGINS: 'https://a.io' })
    expect(originAllowed('https://abc.preview.studio.arc.io', prod)).toBe(false)
  })
})
