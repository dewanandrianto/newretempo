import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createMerchant, idempotencyHeader, seedDataset, type Dataset, type Merchant } from './fixtures'
import { createTestEnv, registerClient, type TestEnv } from './helpers'

let env: TestEnv
let alice: Merchant
let bob: Merchant
let aliceData: Dataset

beforeAll(async () => {
  env = await createTestEnv()
  alice = await createMerchant(env, 'Alice')
  bob = await createMerchant(env, 'Bob')
  aliceData = await seedDataset(alice, { tag: 'alice' })
  await seedDataset(bob, { tag: 'bob' })
  // Give Alice a payment, an escrow, a wallet and an API key as well.
  await alice.client.post(`/api/orgs/${alice.orgId}/payments`, { invoiceId: aliceData.invoiceId }, idempotencyHeader())
  await alice.client.post(`/api/orgs/${alice.orgId}/escrows`, { invoiceId: aliceData.invoiceId, releaseAfterDays: 7 }, idempotencyHeader())
  await alice.client.post(`/api/orgs/${alice.orgId}/wallets`, { purpose: 'payout', address: '0x' + '1'.repeat(40) })
  await alice.client.post(`/api/orgs/${alice.orgId}/api-keys`, { name: 'ci' })
})
afterAll(async () => {
  await env.close()
})

const collections = ['products', 'plans', 'customers', 'subscriptions', 'invoices', 'payments', 'escrows', 'wallets', 'members', 'api-keys', 'audit-logs']

describe('tenant isolation: one merchant cannot reach another merchant', () => {
  test('anonymous requests are rejected everywhere', async () => {
    const anon = env.client()
    for (const c of collections) {
      expect((await anon.get(`/api/orgs/${alice.orgId}/${c}`)).status).toBe(401)
    }
  })

  test("Bob cannot list any of Alice's collections (org id is checked against his memberships)", async () => {
    for (const c of collections) {
      const res = await bob.client.get(`/api/orgs/${alice.orgId}/${c}`)
      expect(res.status).toBe(404)
    }
    expect((await bob.client.get(`/api/orgs/${alice.orgId}`)).status).toBe(404)
  })

  test("Bob cannot read Alice's records by id, even through his own org id", async () => {
    const items: [string, string][] = [
      ['products', aliceData.productId],
      ['plans', aliceData.planId],
      ['customers', aliceData.customerId],
      ['subscriptions', aliceData.subscriptionId],
      ['invoices', aliceData.invoiceId],
    ]
    for (const [collection, id] of items) {
      expect((await bob.client.get(`/api/orgs/${alice.orgId}/${collection}/${id}`)).status).toBe(404)
      expect((await bob.client.get(`/api/orgs/${bob.orgId}/${collection}/${id}`)).status).toBe(404)
    }
  })

  test("Bob's lists never contain Alice's records", async () => {
    for (const c of ['products', 'plans', 'customers', 'subscriptions', 'invoices', 'payments', 'escrows', 'wallets']) {
      const res = await bob.client.get<{ id: string }[]>(`/api/orgs/${bob.orgId}/${c}`)
      const ids = res.body.map((r) => r.id)
      for (const aliceId of Object.values(aliceData)) expect(ids).not.toContain(aliceId)
    }
    const logs = await bob.client.get<{ metadata: Record<string, unknown> }[]>(`/api/orgs/${bob.orgId}/audit-logs`)
    expect(JSON.stringify(logs.body)).not.toContain(alice.orgId)
  })

  test("Bob cannot write into Alice's organization, and nothing is created", async () => {
    const before = (await env.db`SELECT (SELECT count(*) FROM products WHERE org_id = ${alice.orgId})::int AS p, (SELECT count(*) FROM customers WHERE org_id = ${alice.orgId})::int AS c`) as { p: number; c: number }[]
    const base = `/api/orgs/${alice.orgId}`
    expect((await bob.client.post(`${base}/products`, { name: 'Injected' })).status).toBe(404)
    expect((await bob.client.post(`${base}/customers`, { name: 'Injected', email: 'x@example.test' })).status).toBe(404)
    expect((await bob.client.patch(`${base}/products/${aliceData.productId}`, { name: 'Hijacked' })).status).toBe(404)
    expect((await bob.client.del(`${base}/customers/${aliceData.customerId}`)).status).toBe(404)
    expect((await bob.client.post(`${base}/invoices/${aliceData.invoiceId}/void`)).status).toBe(404)
    expect((await bob.client.post(`${base}/payments`, { invoiceId: aliceData.invoiceId }, idempotencyHeader())).status).toBe(404)
    const after = (await env.db`SELECT (SELECT count(*) FROM products WHERE org_id = ${alice.orgId})::int AS p, (SELECT count(*) FROM customers WHERE org_id = ${alice.orgId})::int AS c`) as { p: number; c: number }[]
    expect(after[0]).toEqual(before[0])
    const product = (await env.db`SELECT name FROM products WHERE id = ${aliceData.productId}`) as { name: string }[]
    expect(product[0].name).not.toBe('Hijacked')
  })

  test("Bob cannot point his own records at Alice's records", async () => {
    const base = `/api/orgs/${bob.orgId}`
    expect((await bob.client.post(`${base}/plans`, { productId: aliceData.productId, name: 'X', amount: '1000000', interval: 'month' })).status).toBe(404)
    expect((await bob.client.post(`${base}/subscriptions`, { customerId: aliceData.customerId, planId: aliceData.planId })).status).toBe(404)
    const due = new Date(Date.now() + 86_400_000).toISOString()
    expect((await bob.client.post(`${base}/invoices`, { customerId: aliceData.customerId, lineItems: [{ description: 'x', quantity: 1, unitAmount: '1000000' }], dueAt: due }, idempotencyHeader())).status).toBe(404)
    expect((await bob.client.post(`${base}/payments`, { invoiceId: aliceData.invoiceId }, idempotencyHeader())).status).toBe(404)
    expect((await bob.client.post(`${base}/escrows`, { invoiceId: aliceData.invoiceId }, idempotencyHeader())).status).toBe(404)
    expect((await bob.client.post(`${base}/wallets`, { purpose: 'customer', address: '0x' + '2'.repeat(40), customerId: aliceData.customerId })).status).toBe(404)
  })

  test('the database itself rejects cross-tenant references (composite foreign keys)', async () => {
    let failed = false
    try {
      await env.db`
        INSERT INTO plans (org_id, product_id, name, amount, "interval")
        VALUES (${bob.orgId}, ${aliceData.productId}, 'Smuggled', 1000000, 'month')`
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })

  test('an organization id in the request body is ignored', async () => {
    const res = await bob.client.post<{ id: string }>(`/api/orgs/${bob.orgId}/products`, { name: 'Body org', orgId: alice.orgId, org_id: alice.orgId })
    expect(res.status).toBe(201)
    const row = (await env.db`SELECT org_id FROM products WHERE id = ${res.body.id}`) as { org_id: string }[]
    expect(row[0].org_id).toBe(bob.orgId)
  })

  test('malformed organization ids are 404, not server errors', async () => {
    expect((await bob.client.get('/api/orgs/not-a-uuid/products')).status).toBe(404)
    expect((await bob.client.get(`/api/orgs/${bob.orgId}/products/not-a-uuid`)).status).toBe(404)
    expect((await bob.client.get(`/api/orgs/${bob.orgId}/products/${"1' OR '1'='1"}`)).status).toBe(404)
  })

  test('SQL injection strings are treated as data', async () => {
    const evil = "'); DROP TABLE products; --"
    const res = await alice.client.post<{ name: string }>(`/api/orgs/${alice.orgId}/products`, { name: evil })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe(evil)
    expect((await alice.client.get(`/api/orgs/${alice.orgId}/products`)).status).toBe(200)
  })
})

describe('roles', () => {
  test('owner can add members; roles gate every write', async () => {
    const dana = await registerClient(env, 'Dana')
    const erin = await registerClient(env, 'Erin')
    expect((await alice.client.post(`/api/orgs/${alice.orgId}/members`, { email: dana.email, role: 'member' })).status).toBe(201)
    expect((await alice.client.post(`/api/orgs/${alice.orgId}/members`, { email: erin.email, role: 'admin' })).status).toBe(201)
    const base = `/api/orgs/${alice.orgId}`

    // member: reads everything, writes customers/invoices only
    expect((await dana.client.get(`${base}/invoices`)).status).toBe(200)
    expect((await dana.client.post(`${base}/customers`, { name: 'By member', email: 'bymember@example.test' })).status).toBe(201)
    expect((await dana.client.post(`${base}/products`, { name: 'Nope' })).status).toBe(403)
    expect((await dana.client.post(`${base}/escrows`, { invoiceId: aliceData.invoiceId }, idempotencyHeader())).status).toBe(403)
    expect((await dana.client.post(`${base}/api-keys`, { name: 'k' })).status).toBe(403)
    expect((await dana.client.get(`${base}/api-keys`)).status).toBe(403)
    expect((await dana.client.patch(`${base}`, { name: 'Renamed' })).status).toBe(403)
    expect((await dana.client.post(`${base}/members`, { email: erin.email, role: 'member' })).status).toBe(403)

    // admin: operational writes, but cannot touch owners or grant admin
    expect((await erin.client.post(`${base}/products`, { name: 'By admin' })).status).toBe(201)
    expect((await erin.client.patch(`${base}`, { name: 'Alice Inc (renamed)' })).status).toBe(200)
    expect((await erin.client.patch(`${base}/members/${alice.userId}`, { role: 'member' })).status).toBe(403)
    expect((await erin.client.del(`${base}/members/${alice.userId}`)).status).toBe(403)
    expect((await erin.client.patch(`${base}/members/${dana.userId}`, { role: 'admin' })).status).toBe(403)
    expect((await erin.client.post(`${base}/members`, { email: bob.email, role: 'admin' })).status).toBe(403)
  })

  test('the last owner cannot leave or be demoted', async () => {
    const solo = await createMerchant(env, 'Solo')
    const base = `/api/orgs/${solo.orgId}`
    expect((await solo.client.del(`${base}/members/${solo.userId}`)).status).toBe(409)
    expect((await solo.client.patch(`${base}/members/${solo.userId}`, { role: 'admin' })).status).toBe(403)
  })

  test('removed members lose access immediately', async () => {
    const owner = await createMerchant(env, 'Boss')
    const worker = await registerClient(env, 'Worker')
    const base = `/api/orgs/${owner.orgId}`
    await owner.client.post(`${base}/members`, { email: worker.email, role: 'member' })
    expect((await worker.client.get(`${base}/customers`)).status).toBe(200)
    expect((await owner.client.del(`${base}/members/${worker.userId}`)).status).toBe(204)
    expect((await worker.client.get(`${base}/customers`)).status).toBe(404)
  })

  test('creating an organization requires a verified email when the server demands it', async () => {
    const strict = await createTestEnv({ REQUIRE_VERIFIED_EMAIL: 'true' }, false)
    try {
      const u = await registerClient(strict, 'Unverified')
      const body = { name: 'Needs Verify', slug: `needs-verify-${Date.now().toString(36)}`, industry: 'SaaS', country: 'US' }
      expect((await u.client.post('/api/orgs', body)).status).toBe(403)
      await u.client.post('/api/auth/verify-email', { token: strict.mailer.tokenFor(u.email, 'verify_email') })
      expect((await u.client.post('/api/orgs', body)).status).toBe(201)
    } finally {
      await strict.close()
    }
  })
})
