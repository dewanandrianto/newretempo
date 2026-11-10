import { env as rawEnv } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { createHttpApp } from '../src/http'
import type { WorkerBindings } from '../src/types'
import { registerCatalogRoutes } from '../src/catalog/routes'
import { randomToken } from '../src/auth/crypto'
const env = rawEnv as unknown as WorkerBindings

const owner = '10000000-0000-4000-8000-000000000001'
const member = '10000000-0000-4000-8000-000000000002'
const outsider = '10000000-0000-4000-8000-000000000003'
const app = createHttpApp({ resolveAuth: c => {
  const id = c.req.header('x-test-user') ?? owner
  return { userId: id, sessionId: crypto.randomUUID(), method: 'password', user: { id, email: `${id}@test.com`, displayName: 'Test', emailVerified: c.req.header('x-test-unverified') !== 'true' } }
} })
registerCatalogRoutes(app)
const bindings = () => ({ ...env, APP_ENV: 'test', SESSION_SECRET: 'catalog-integration-only-secret-32-bytes', SIWE_CHAIN_ID: '5042002', REQUIRE_VERIFIED_EMAIL: 'false' }) as WorkerBindings
async function request(path: string, method = 'GET', body?: unknown, user = owner) {
  return app.request(`http://local/api/orgs${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': user, origin: 'https://app.test', 'x-requested-with': 'retempo' }, body: body === undefined ? undefined : JSON.stringify(body) }, bindings())
}
async function organization(slug = 'catalog-test') {
  const response = await request('', 'POST', { name: 'Catalog Test', slug, industry: 'Software', country: 'Indonesia' })
  expect(response.status).toBe(201)
  return await response.json<{ id: string }>()
}
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM rate_limits WHERE key=?').bind(`org:create:${owner}`).run()
  for (const id of [owner, member, outsider]) await env.DB.prepare("INSERT OR IGNORE INTO users (id,email,display_name,email_verified_at) VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(id, `${id}@test.com`, 'Test').run()
})
describe('catalog D1 integration', () => {
  it('defaults to requiring verified email for production onboarding', async () => {
    const response = await app.request('https://app.retempo.xyz/api/orgs', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.retempo.xyz', 'x-requested-with': 'retempo', 'x-test-unverified': 'true' }, body: JSON.stringify({ name: 'Unverified', slug: 'catalog-unverified', industry: 'Software', country: 'Indonesia' }) }, { ...bindings(), APP_ENV: 'production', SESSION_SECRET: randomToken(), APP_ORIGINS: 'https://app.retempo.xyz', SIWE_DOMAIN: 'app.retempo.xyz', SIWE_URI: 'https://app.retempo.xyz', EMAIL_MODE: 'disabled', COOKIE_SECURE: 'true', REQUIRE_VERIFIED_EMAIL: undefined })
    expect(response.status).toBe(403)
    expect(await env.DB.prepare('SELECT id FROM organizations WHERE slug=?').bind('catalog-unverified').first()).toBeNull()
  })
  it('does not append success audits for missing resources or failed constraints', async () => {
    const org = await organization('catalog-failed-audit'), base = `/${org.id}`
    const initial = await env.DB.prepare('SELECT count(*) AS n FROM audit_logs WHERE org_id=?').bind(org.id).first()
    const missing = crypto.randomUUID()
    for (const route of ['products', 'plans', 'customers', 'wallets', 'api-keys']) {
      expect((await request(`${base}/${route}/${missing}`, 'DELETE')).status).toBe(404)
    }
    expect(await env.DB.prepare('SELECT count(*) AS n FROM audit_logs WHERE org_id=?').bind(org.id).first()).toEqual(initial)
    const product = await (await request(`${base}/products`, 'POST', { name: 'Unique' })).json() as { id: string }
    const after = await env.DB.prepare('SELECT count(*) AS n FROM audit_logs WHERE org_id=?').bind(org.id).first()
    expect((await request(`${base}/products`, 'POST', { name: 'unique' })).status).toBe(409)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM audit_logs WHERE org_id=?').bind(org.id).first()).toEqual(after)
    expect((await request(`${base}/products/${product.id}`)).status).toBe(200)
  })
  it('rolls back organization and owner membership together when their audit fails', async () => {
    await env.DB.exec("CREATE TRIGGER catalog_fail_org_audit BEFORE INSERT ON audit_logs WHEN NEW.action='organization.created' BEGIN SELECT RAISE(ABORT,'catalog audit failure'); END")
    try {
      expect((await request('', 'POST', { name: 'Atomic Org', slug: 'catalog-org-rollback', industry: 'Software', country: 'Indonesia' })).status).toBe(500)
      expect(await env.DB.prepare('SELECT id FROM organizations WHERE slug=?').bind('catalog-org-rollback').first()).toBeNull()
      expect((await env.DB.prepare('SELECT m.id FROM memberships m LEFT JOIN organizations o ON o.id=m.org_id WHERE o.id IS NULL').all()).results).toEqual([])
    } finally { await env.DB.exec('DROP TRIGGER catalog_fail_org_audit') }
  })
  it('rolls back updates and deletions when their audit fails', async () => {
    const org = await organization('catalog-update-rollback'), base = `/${org.id}`
    const product = await (await request(`${base}/products`, 'POST', { name: 'Before' })).json() as { id: string }
    await env.DB.exec("CREATE TRIGGER catalog_fail_change_audit BEFORE INSERT ON audit_logs WHEN NEW.action IN ('product.updated','product.deleted') BEGIN SELECT RAISE(ABORT,'catalog audit failure'); END")
    try {
      expect((await request(`${base}/products/${product.id}`, 'PATCH', { name: 'After' })).status).toBe(500)
      expect(await (await request(`${base}/products/${product.id}`)).json()).toMatchObject({ name: 'Before' })
      expect((await request(`${base}/products/${product.id}`, 'DELETE')).status).toBe(500)
      expect((await request(`${base}/products/${product.id}`)).status).toBe(200)
    } finally { await env.DB.exec('DROP TRIGGER catalog_fail_change_audit') }
  })
  it('preserves all plan fields, canonicalizes accepted integer strings, and counts non-canceled subscriptions only', async () => {
    const org = await organization('catalog-plan-fields'), base = `/${org.id}`
    const product = await (await request(`${base}/products`, 'POST', { name: 'Product' })).json() as { id: string }
    const plan = await (await request(`${base}/plans`, 'POST', { productId: product.id, name: 'Plan', amount: '0001', interval: 'year', trialDays: 20, escrowDays: 10 })).json() as { id: string }
    expect(plan).toMatchObject({ amount: '1', trialDays: 20, escrowDays: 10, interval: 'year', productName: 'Product', subscriberCount: 0 })
    const changed = await request(`${base}/plans/${plan.id}`, 'PATCH', { name: 'Changed', amount: '9007199254740993', trialDays: 365, escrowDays: 90, status: 'archived' })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({ name: 'Changed', amount: '9007199254740993', trialDays: 365, escrowDays: 90, status: 'archived', interval: 'year' })
    expect(await (await request(`${base}/products/${product.id}`)).json()).toMatchObject({ planCount: 1 })
    expect(await (await request(`${base}/plans?limit=1`)).json()).toHaveLength(1)
    const customer = await (await request(`${base}/customers`, 'POST', { name: 'Subscriber', email: 'subscriber@test.com' })).json() as { id: string }
    const canceledId = crypto.randomUUID()
    for (const id of [crypto.randomUUID(), canceledId]) await env.DB.prepare("INSERT INTO subscriptions (id,org_id,customer_id,plan_id,amount,interval) VALUES (?,?,?,?,?,'year')").bind(id, org.id, customer.id, plan.id, '1').run()
    await env.DB.prepare("UPDATE subscriptions SET status='canceled' WHERE id=?").bind(canceledId).run()
    expect(await (await request(`${base}/plans/${plan.id}`)).json()).toMatchObject({ subscriberCount: 1 })
    expect((await request(`${base}/plans/${plan.id}`, 'DELETE')).status).toBe(409)
    expect((await request(`${base}/customers/${customer.id}`, 'DELETE')).status).toBe(409)
    expect((await request(`${base}/plans/${plan.id}`, 'PATCH', {})).status).toBe(400)
    for (const invalid of ['0', '-1', '1.1', '1e6', '9223372036854775808', 10]) {
      expect((await request(`${base}/plans/${plan.id}`, 'PATCH', { amount: invalid })).status).toBe(422)
    }
    expect((await request(`${base}/plans/${plan.id}`, 'PATCH', { trialDays: 366 })).status).toBe(422)
    expect((await request(`${base}/plans/${plan.id}`, 'PATCH', { escrowDays: 91 })).status).toBe(422)
    expect((await request(`${base}/products/${product.id}`, 'PATCH', { status: 'archived' })).status).toBe(200)
    expect((await request(`${base}/plans`, 'POST', { productId: product.id, name: 'Archived Parent', amount: '1', interval: 'month' })).status).toBe(404)
  })
  it('limits organization onboarding to five attempts per account per day', async () => {
    for (let i = 0; i < 5; i++) await organization(`catalog-rate-${i}`)
    const response = await request('', 'POST', { name: 'Blocked', slug: 'catalog-rate-blocked', industry: 'Software', country: 'Indonesia' })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBeTruthy()
    expect(await env.DB.prepare('SELECT id FROM organizations WHERE slug=?').bind('catalog-rate-blocked').first()).toBeNull()
  })
  it('supports customer field updates, case-normalized duplicates, paging, and deletion gates', async () => {
    const org = await organization('catalog-customer-crud'), other = await organization('catalog-customer-other'), base = `/${org.id}`
    await request(`${base}/members`, 'POST', { email: `${member}@test.com`, role: 'member' })
    const response = await request(`${base}/customers`, 'POST', { name: 'First', email: ' FIRST@TEST.COM ', company: 'Before' }, member)
    expect(response.status).toBe(201)
    const customer = await response.json() as { id: string }
    expect(customer).toMatchObject({ email: 'first@test.com', company: 'Before', status: 'active' })
    expect((await request(`${base}/customers`, 'POST', { name: 'Duplicate', email: 'first@test.com' })).status).toBe(409)
    expect((await request(`/${other.id}/customers/${customer.id}`)).status).toBe(404)
    const updated = await request(`${base}/customers/${customer.id}`, 'PATCH', { name: 'After', company: '', email: 'after@test.com', status: 'archived' }, member)
    expect(await updated.json()).toMatchObject({ name: 'After', company: '', email: 'after@test.com', status: 'archived' })
    expect(await (await request(`${base}/customers?limit=1&offset=0`)).json()).toHaveLength(1)
    expect(await (await request(`${base}/customers?limit=1&offset=1`)).json()).toEqual([])
    expect((await request(`${base}/customers?limit=201`)).status).toBe(422)
    expect((await request(`${base}/customers/${customer.id}`, 'DELETE', undefined, member)).status).toBe(403)
    expect((await request(`${base}/customers/${customer.id}`, 'DELETE')).status).toBe(204)
    expect((await request(`${base}/customers/${customer.id}`)).status).toBe(404)
  })
  it('allows admins to manage only lower-ranked members and blocks non-admin secret and audit access', async () => {
    const org = await organization('catalog-admin'), base = `/${org.id}`
    expect((await request(`${base}/members`, 'POST', { email: `${member}@test.com`, role: 'admin' })).status).toBe(201)
    expect((await request(`${base}/members`, 'POST', { email: `${outsider}@test.com`, role: 'admin' }, member)).status).toBe(403)
    expect((await request(`${base}/members`, 'POST', { email: `${outsider}@test.com`, role: 'member' }, member)).status).toBe(201)
    expect((await request(`${base}/api-keys`, 'GET', undefined, outsider)).status).toBe(403)
    expect((await request(`${base}/audit-logs`, 'GET', undefined, outsider)).status).toBe(403)
    expect((await request(`${base}/wallets`, 'POST', { purpose: 'payout', address: `0x${'ab'.repeat(20)}` }, outsider)).status).toBe(403)
    expect((await request(`${base}/members/${owner}`, 'DELETE', undefined, member)).status).toBe(403)
    expect((await request(`${base}/members/${member}`, 'PATCH', { role: 'member' }, member)).status).toBe(403)
    expect((await request(`${base}/members/${outsider}`, 'PATCH', { role: 'admin' }, member)).status).toBe(403)
    expect((await request(`${base}/members/${outsider}`, 'DELETE', undefined, member)).status).toBe(204)
    expect((await request(`${base}/members/${member}`, 'PATCH', { role: 'member' })).status).toBe(200)
  })
  it('stores unverified wallet associations with validated tenant customer references', async () => {
    const org = await organization('catalog-wallets'), other = await organization('catalog-wallet-other'), base = `/${org.id}`
    const customerResponse = await request(`${base}/customers`, 'POST', { name: 'Customer', email: 'wallet@test.com', company: 'Acme' })
    expect(customerResponse.status).toBe(201)
    const customer = await customerResponse.json() as { id: string }
    const address = `0x${'AB'.repeat(20)}`
    expect((await request(`${base}/wallets`, 'POST', { purpose: 'customer', address })).status).toBe(422)
    expect((await request(`/${other.id}/wallets`, 'POST', { purpose: 'customer', address, customerId: customer.id })).status).toBe(404)
    expect((await request(`${base}/wallets`, 'POST', { purpose: 'payout', address, customerId: customer.id })).status).toBe(422)
    const created = await request(`${base}/wallets`, 'POST', { purpose: 'customer', address, customerId: customer.id, label: 'Customer' })
    expect(created.status).toBe(201)
    const wallet = await created.json() as { id: string }
    expect(wallet).toMatchObject({ verified: false, address: address.toLowerCase(), customerId: customer.id, label: 'Customer' })
    expect((await request(`${base}/wallets`, 'POST', { purpose: 'customer', address, customerId: customer.id })).status).toBe(409)
    const updated = await request(`${base}/wallets/${wallet.id}`, 'PATCH', { label: 'Updated' })
    expect(await updated.json()).toMatchObject({ label: 'Updated', verified: false })
    expect((await request(`/${other.id}/wallets/${wallet.id}`, 'DELETE')).status).toBe(404)
    expect((await request(`${base}/wallets/${wallet.id}`, 'DELETE')).status).toBe(204)
    expect(await (await request(`${base}/wallets`)).json()).toEqual([])
  })
  it('issues keyed-hash API key records once and retains scopes, expiry and revocation', async () => {
    const org = await organization('catalog-keys'), other = await organization('catalog-key-other'), base = `/${org.id}`
    const created = await request(`${base}/api-keys`, 'POST', { name: 'Integration', scopes: ['read', 'write'], expiresInDays: 7 })
    expect(created.status).toBe(201)
    const key = await created.json() as { id: string; secret: string; expiresAt: string }
    expect(key.secret).toMatch(/^rtk_test_[^.]+\..+$/)
    const stored = await env.DB.prepare('SELECT key_hash,scopes,expires_at FROM api_keys WHERE id=?').bind(key.id).first<{ key_hash: string; scopes: string; expires_at: string }>()
    expect(stored?.key_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored?.key_hash).not.toBe(key.secret)
    expect(JSON.parse(stored!.scopes)).toEqual(['read', 'write'])
    expect(stored?.expires_at).toBe(key.expiresAt)
    const listed = await (await request(`${base}/api-keys`)).json() as unknown[]
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain(key.secret)
    expect((await request(`/${other.id}/api-keys/${key.id}`, 'DELETE')).status).toBe(404)
    expect((await request(`${base}/api-keys/${key.id}`, 'DELETE')).status).toBe(204)
    expect((await request(`${base}/api-keys/${key.id}`, 'DELETE')).status).toBe(404)
    expect(await env.DB.prepare('SELECT revoked_at FROM api_keys WHERE id=?').bind(key.id).first()).toMatchObject({ revoked_at: expect.any(String) as unknown })
    const logs = await (await request(`${base}/audit-logs?limit=1&offset=0`)).json() as { action: string }[]
    expect(logs).toHaveLength(1)
    expect(logs[0].action).toBe('api_key.revoked')
  })
  it('rolls back a mutation when the audit insertion fails', async () => {
    const org = await organization('catalog-atomic')
    await env.DB.exec("CREATE TRIGGER catalog_fail_audit BEFORE INSERT ON audit_logs WHEN NEW.action='product.created' BEGIN SELECT RAISE(ABORT,'catalog audit failure'); END")
    try {
      expect((await request(`/${org.id}/products`, 'POST', { name: 'Rolled Back' })).status).toBe(500)
      expect((await env.DB.prepare('SELECT id FROM products WHERE org_id=?').bind(org.id).all()).results).toEqual([])
      expect((await env.DB.prepare("SELECT id FROM audit_logs WHERE org_id=? AND action='product.created'").bind(org.id).all()).results).toEqual([])
    } finally { await env.DB.exec('DROP TRIGGER catalog_fail_audit') }
  })
  it('enforces role hierarchy, self-leave, and last-owner protection', async () => {
    const org = await organization('catalog-roles'), base = `/${org.id}`
    expect((await request(`${base}/members`, 'POST', { email: `${member}@test.com`, role: 'member' })).status).toBe(201)
    expect((await request(`${base}/products`, 'POST', { name: 'Denied' }, member)).status).toBe(403)
    expect((await request(`${base}/customers`, 'POST', { name: 'Allowed', email: 'allowed@test.com' }, member)).status).toBe(201)
    expect((await request(`${base}/members/${owner}`, 'PATCH', { role: 'admin' })).status).toBe(403)
    const last = await request(`${base}/members/${owner}`, 'DELETE')
    expect(last.status).toBe(409)
    expect(await last.json()).toMatchObject({ error: { code: 'last_owner' } })
    expect((await request(`${base}/members/${member}`, 'PATCH', { role: 'owner' })).status).toBe(403)
    expect((await request(`${base}/members/${member}`, 'DELETE', undefined, member)).status).toBe(204)
    expect((await request(`${base}/members`, 'GET', undefined, member)).status).toBe(404)
  })
  it('updates the organization profile and permits clearing its website', async () => {
    const org = await organization('catalog-profile')
    const response = await request(`/${org.id}`, 'PATCH', { name: 'Updated', website: 'https://example.com', industry: 'Finance', country: 'Singapore' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ name: 'Updated', website: 'https://example.com', industry: 'Finance', country: 'Singapore' })
    const cleared = await request(`/${org.id}`, 'PATCH', { website: '' })
    expect(await cleared.json()).toMatchObject({ website: null })
  })
  it('supports product CRUD with tenant isolation, duplicate conflicts, and exact large plan amounts', async () => {
    const org = await organization('catalog-products')
    const base = `/${org.id}`
    const created = await request(`${base}/products`, 'POST', { name: 'Product', description: 'Original' })
    expect(created.status).toBe(201)
    const product = await created.json() as { id: string }
    expect((await request(`${base}/products`, 'POST', { name: 'Product' })).status).toBe(409)
    expect((await request(`${base}/products/${product.id}`, 'GET', undefined, outsider)).status).toBe(404)
    const other = await organization('catalog-other')
    expect((await request(`/${other.id}/products/${product.id}`)).status).toBe(404)
    expect((await request(`${base}/products/${product.id}`, 'PATCH', {})).status).toBe(400)
    expect((await request(`${base}/products/${product.id}`, 'PATCH', { description: 'Changed' })).status).toBe(200)
    const planResponse = await request(`${base}/plans`, 'POST', { productId: product.id, name: 'Large', amount: '9223372036854775807', interval: 'month' })
    expect(planResponse.status).toBe(201)
    const plan = await planResponse.json() as { id: string; amount: string }
    expect(plan.amount).toBe('9223372036854775807')
    const stored = await env.DB.prepare('SELECT amount,typeof(amount) AS kind FROM plans WHERE id=?').bind(plan.id).first()
    expect(stored).toEqual({ amount: plan.amount, kind: 'text' })
    expect((await request(`${base}/plans`, 'POST', { productId: product.id, name: 'Overflow', amount: '9223372036854775808', interval: 'month' })).status).toBe(422)
    expect((await request(`/${other.id}/plans`, 'POST', { productId: product.id, name: 'Foreign', amount: '1', interval: 'month' })).status).toBe(404)
    expect((await request(`${base}/products/${product.id}`, 'DELETE')).status).toBe(409)
    expect((await request(`${base}/plans/${plan.id}`, 'DELETE')).status).toBe(204)
    expect((await request(`${base}/products/${product.id}`, 'DELETE')).status).toBe(204)
  })
  it('creates an organization, owner membership, and audit atomically', async () => {
    const org = await organization()
    expect((await request(`/${org.id}`)).status).toBe(200)
    const memberships = await (await request('')).json() as { role: string; organization: { id: string } }[]
    expect(memberships).toContainEqual(expect.objectContaining({ role: 'owner', organization: expect.objectContaining({ id: org.id }) as unknown }))
    const audit = await env.DB.prepare('SELECT action FROM audit_logs WHERE org_id=?').bind(org.id).all()
    expect(audit.results).toContainEqual({ action: 'organization.created' })
  })
})
