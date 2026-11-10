import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildApp } from '../src/app'
import { UnconfiguredMailer } from '../src/auth/mailer'
import { RateLimiter } from '../src/http/rateLimit'
import { ORIGIN, TEST_PASSWORD, createTestEnv, registerClient, uniqueEmail, type TestEnv } from './helpers'

let env: TestEnv
beforeAll(async () => {
  env = await createTestEnv()
})
afterAll(async () => {
  await env.close()
})

type Me = { user: { id: string; email: string; emailVerified: boolean }; memberships: unknown[] }
type Err = { error: { code: string; message: string; fields?: Record<string, string> } }

describe('registration and session cookie', () => {
  test('creates an account and an HttpOnly, SameSite session cookie', async () => {
    const client = env.client()
    const email = uniqueEmail()
    const res = await client.post<Me>('/api/auth/register', { email, password: TEST_PASSWORD, name: 'Ada' })
    expect(res.status).toBe(201)
    const cookie = res.headers.getSetCookie()[0]
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).toMatch(/Max-Age=\d+/)
    expect(JSON.stringify(res.body)).not.toContain(TEST_PASSWORD)
    expect(JSON.stringify(res.body)).not.toContain('password_hash')
    expect((await client.get<Me>('/api/auth/me')).body.user.email).toBe(email)
  })

  test('stores an Argon2id hash, never the plaintext password', async () => {
    const { email } = await registerClient(env)
    const rows = (await env.db`SELECT password_hash FROM users WHERE email = ${email}`) as { password_hash: string }[]
    expect(rows[0].password_hash.startsWith('$argon2id$')).toBe(true)
    expect(rows[0].password_hash).not.toContain(TEST_PASSWORD)
  })

  test('only a hash of the session token is stored', async () => {
    const { client } = await registerClient(env)
    const token = decodeURIComponent([...client.cookies.values()][0])
    const rows = (await env.db`SELECT token_hash FROM sessions WHERE token_hash = ${token}`) as unknown[]
    expect(rows).toHaveLength(0)
  })

  test('rejects duplicate emails and weak passwords', async () => {
    const { email } = await registerClient(env)
    const dup = await env.client().post<Err>('/api/auth/register', { email, password: TEST_PASSWORD, name: 'Dup' })
    expect(dup.status).toBe(409)
    const weak = await env.client().post<Err>('/api/auth/register', { email: uniqueEmail(), password: 'short', name: 'Weak' })
    expect(weak.status).toBe(422)
    expect(weak.body.error.fields?.password).toBeDefined()
  })

  test('Secure and __Host- prefix are applied when configured', async () => {
    const secure = await createTestEnv({ COOKIE_SECURE: 'true' }, false)
    try {
      const res = await secure.client().post('/api/auth/register', { email: uniqueEmail(), password: TEST_PASSWORD, name: 'S' })
      const cookie = res.headers.getSetCookie()[0]
      expect(cookie.startsWith('__Host-retempo_session=')).toBe(true)
      expect(cookie).toContain('Secure')
    } finally {
      await secure.close()
    }
  })
})

describe('login, rotation and logout', () => {
  test('wrong password and unknown email return the same generic error', async () => {
    const { email } = await registerClient(env)
    const a = await env.client().post<Err>('/api/auth/login', { email, password: 'not the right password' })
    const b = await env.client().post<Err>('/api/auth/login', { email: uniqueEmail('ghost'), password: 'not the right password' })
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(a.body.error.message).toBe(b.body.error.message)
  })

  test('login rotates the session: the previous cookie stops working', async () => {
    const { client, email } = await registerClient(env)
    const oldCookie = client.cookieHeader()
    const res = await client.post('/api/auth/login', { email, password: TEST_PASSWORD })
    expect(res.status).toBe(200)
    expect(client.cookieHeader()).not.toBe(oldCookie)
    const replay = await env.app.fetch(new Request(`${ORIGIN}/api/auth/me`, { headers: { Cookie: oldCookie } }), '10.9.9.9')
    expect(replay.status).toBe(401)
    expect((await client.get('/api/auth/me')).status).toBe(200)
  })

  test('logout revokes the session server-side', async () => {
    const { client } = await registerClient(env)
    const cookie = client.cookieHeader()
    expect((await client.post('/api/auth/logout')).status).toBe(200)
    const replay = await env.app.fetch(new Request(`${ORIGIN}/api/auth/me`, { headers: { Cookie: cookie } }), '10.9.9.9')
    expect(replay.status).toBe(401)
  })

  test('expired and idle-expired sessions are rejected', async () => {
    const { client, userId } = await registerClient(env)
    await env.db`UPDATE sessions SET idle_expires_at = now() - interval '1 minute' WHERE user_id = ${userId}`
    expect((await client.get('/api/auth/me')).status).toBe(401)
    const second = await registerClient(env)
    await env.db`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = ${second.userId}`
    expect((await second.client.get('/api/auth/me')).status).toBe(401)
  })

  test('failed logins are rate limited per email', async () => {
    const { email } = await registerClient(env)
    let last = 0
    for (let i = 0; i < 10; i++) {
      last = (await env.client().post('/api/auth/login', { email, password: 'wrong wrong wrong' })).status
    }
    expect(last).toBe(429)
  })
})

describe('CSRF and request hardening', () => {
  test('state-changing requests need an allowed Origin and the custom header', async () => {
    const { client, email } = await registerClient(env)
    const body = JSON.stringify({ email, password: TEST_PASSWORD })
    const noHeader = await env.app.fetch(
      new Request(`${ORIGIN}/api/auth/login`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: client.cookieHeader() }, body }),
      '10.8.8.8',
    )
    expect(noHeader.status).toBe(403)
    const badOrigin = await env.app.fetch(
      new Request(`${ORIGIN}/api/auth/login`, { method: 'POST', headers: { Origin: 'https://evil.test', 'X-Requested-With': 'retempo', 'Content-Type': 'application/json' }, body }),
      '10.8.8.8',
    )
    expect(badOrigin.status).toBe(403)
    const noOrigin = await env.app.fetch(
      new Request(`${ORIGIN}/api/auth/login`, { method: 'POST', headers: { 'X-Requested-With': 'retempo', 'Content-Type': 'application/json' }, body }),
      '10.8.8.8',
    )
    expect(noOrigin.status).toBe(403)
  })

  test('responses carry security headers and no stack traces', async () => {
    const res = await env.client().get('/api/health')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const bad = await env.app.fetch(
      new Request(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'X-Requested-With': 'retempo', 'Content-Type': 'application/json' },
        body: '{not json',
      }),
      '10.6.6.6',
    )
    expect(bad.status).toBe(400)
    expect(await bad.text()).not.toContain('at ')
  })
})

describe('email verification', () => {
  test('tokens are hashed at rest, single use, and verify the account', async () => {
    const { client, email } = await registerClient(env)
    const token = env.mailer.tokenFor(email, 'verify_email')
    const stored = (await env.db`SELECT token_hash FROM email_tokens WHERE token_hash = ${token}`) as unknown[]
    expect(stored).toHaveLength(0)
    expect((await client.get<Me>('/api/auth/me')).body.user.emailVerified).toBe(false)
    expect((await env.client().post('/api/auth/verify-email', { token })).status).toBe(200)
    expect((await client.get<Me>('/api/auth/me')).body.user.emailVerified).toBe(true)
    expect((await env.client().post('/api/auth/verify-email', { token })).status).toBe(401)
  })

  test('expired tokens are rejected', async () => {
    const { email, userId } = await registerClient(env)
    const token = env.mailer.tokenFor(email, 'verify_email')
    await env.db`UPDATE email_tokens SET expires_at = now() - interval '1 second' WHERE user_id = ${userId}`
    expect((await env.client().post('/api/auth/verify-email', { token })).status).toBe(401)
  })

  test('registration fails safely when no email provider is configured', async () => {
    const app = buildApp({ config: env.config, db: env.db, mailer: new UnconfiguredMailer(), limiter: new RateLimiter() })
    const email = uniqueEmail('nomail')
    const res = await app.fetch(
      new Request(`${ORIGIN}/api/auth/register`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'X-Requested-With': 'retempo', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: TEST_PASSWORD, name: 'X' }),
      }),
      '10.7.7.7',
    )
    expect(res.status).toBe(503)
    const rows = (await env.db`SELECT id FROM users WHERE email = ${email}`) as unknown[]
    expect(rows).toHaveLength(0)
  })
})

describe('password reset', () => {
  test('resets the password, revokes every session, and the token is single use', async () => {
    const { client, email } = await registerClient(env)
    const other = env.client()
    await other.post('/api/auth/login', { email, password: TEST_PASSWORD })

    expect((await env.client().post('/api/auth/forgot-password', { email })).status).toBe(200)
    const token = env.mailer.tokenFor(email, 'reset_password')
    const newPassword = 'a brand new passphrase 42'
    expect((await env.client().post('/api/auth/reset-password', { token, password: newPassword })).status).toBe(200)

    expect((await client.get('/api/auth/me')).status).toBe(401)
    expect((await other.get('/api/auth/me')).status).toBe(401)
    expect((await env.client().post('/api/auth/login', { email, password: TEST_PASSWORD })).status).toBe(401)
    expect((await env.client().post('/api/auth/login', { email, password: newPassword })).status).toBe(200)
    expect((await env.client().post('/api/auth/reset-password', { token, password: 'yet another passphrase 7' })).status).toBe(401)
  })

  test('unknown emails get the same response and no email is sent', async () => {
    const before = env.mailer.sent.length
    const res = await env.client().post('/api/auth/forgot-password', { email: uniqueEmail('nobody') })
    expect(res.status).toBe(200)
    expect(env.mailer.sent.length).toBe(before)
  })
})
