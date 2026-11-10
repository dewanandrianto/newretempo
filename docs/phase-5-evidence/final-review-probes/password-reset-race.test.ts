import { env as rawEnv } from 'cloudflare:test'
import { Hono } from 'hono'
import { expect, test } from 'vitest'
import { createWorkerApp } from '../../../worker/src/index'
import { authenticatePassword } from '../../../worker/src/auth/service'
import { establishSession } from '../../../worker/src/auth/sessions'
import { randomToken } from '../../../worker/src/auth/crypto'
import type { WorkerBindings, WorkerContext } from '../../../worker/src/types'

test('security acceptance: password login paused across reset must not mint a session from the old credential', async () => {
  let token = ''
  const bindings: WorkerBindings = { ...(rawEnv as unknown as WorkerBindings), APP_ENV: 'production', SESSION_SECRET: randomToken(), APP_ORIGINS: 'https://app.retempo.xyz', SIWE_DOMAIN: 'app.retempo.xyz', SIWE_URI: 'https://app.retempo.xyz', COOKIE_SECURE: 'true', EMAIL_MODE: 'delivery', REQUIRE_VERIFIED_EMAIL: 'true', MAILER: { fetch: async (r: Request) => { token = (await r.json<{link:string}>()).link.split('#')[1]; return new Response('ok') } } as Fetcher }
  const app = createWorkerApp(), email = `final-review-${crypto.randomUUID()}@example.com`, oldPassword = 'Old-password-review-92!', newPassword = 'New-password-review-94!'
  const request = (path: string, body: unknown, cookie?: string) => app.request(`https://app.retempo.xyz/api/auth/${path}`, { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.240', Origin: bindings.APP_ORIGINS, 'X-Requested-With': 'retempo', 'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {}) }, body: JSON.stringify(body) }, bindings)
  const registration = await request('register', { email, password: oldPassword, name: 'Review' })
  expect(registration.status).toBe(201)
  expect((await request('verify-email', {token})).status).toBe(200)
  const gate = new Hono<WorkerContext>()
  gate.post('/race', async c => {
    c.set('ip', '192.0.2.241'); c.set('requestId', crypto.randomUUID())
    const user = await authenticatePassword(c, {email, password: oldPassword})
    expect((await request('forgot-password', {email})).status).toBe(200)
    expect((await request('reset-password', {token, password: newPassword})).status).toBe(200)
    await establishSession(c, user, 'password')
    return c.json({ok: true})
  })
  const raced = await gate.request('https://app.retempo.xyz/race', {method:'POST'}, bindings)
  const cookie = raced.headers.get('set-cookie')?.split(';')[0]
  const me = await app.request('https://app.retempo.xyz/api/auth/me', {headers: cookie ? {Cookie:cookie} : {}}, bindings)
  const live = await bindings.DB.prepare('SELECT auth_method FROM sessions WHERE revoked_at IS NULL').all()
  console.log('final-review-password-reset-race', JSON.stringify({raceStatus:raced.status, issuedCookie:!!cookie, authenticatedMeStatus:me.status, liveSessions:live.results}))
  expect(raced.headers.get('set-cookie')).toBeNull()
  expect(me.status).toBe(401)
})
