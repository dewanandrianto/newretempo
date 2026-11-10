import { env as testEnv } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { createHttpApp } from '../src/http'
import type { WorkerBindings } from '../src/types'
import { registerBillingRoutes } from '../src/billing/routes'

const env = testEnv as unknown as WorkerBindings

const owner = '20000000-0000-4000-8000-000000000001'
const member = '20000000-0000-4000-8000-000000000002'
const outsider = '20000000-0000-4000-8000-000000000003'
let org: string, customer: string, product: string, plan: string
const big = '9007199254740993'
const app = createHttpApp({ resolveAuth: c => {
  const id = c.req.header('x-test-user') ?? owner
  return id === 'anonymous' ? null : { sessionId: crypto.randomUUID(), userId: id, method: 'password', user: { id, email: `${id}@test.com`, displayName: 'Test', emailVerified: true } }
} })
registerBillingRoutes(app)
async function request(path: string, method = 'GET', body?: unknown, key?: string, user = owner, tenant = org) {
  return app.request(`http://local/api/orgs/${tenant}/${path}`, { method, headers: { 'content-type': 'application/json', 'Origin': 'https://app.test', 'X-Requested-With': 'retempo', 'x-test-user': user, ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, { ...env, APP_ENV: 'test', SIWE_CHAIN_ID: '5042' })
}
const invoiceBody = (amount = big) => ({ customerId: customer, dueAt: '2026-12-01T00:00:00.000Z', lineItems: [{ description: 'Exact', quantity: 2, unitAmount: amount }], memo: '' })
async function invoice(open = true) {
  const r = await request('invoices', 'POST', invoiceBody(), crypto.randomUUID())
  expect(r.status, await r.clone().text()).toBe(201)
  const data = await r.json() as { id: string; total: string }
  if (open) expect((await request(`invoices/${data.id}/finalize`, 'POST')).status).toBe(200)
  return data
}
beforeEach(async () => {
  org = crypto.randomUUID(); customer = crypto.randomUUID(); product = crypto.randomUUID(); plan = crypto.randomUUID()
  for (const id of [owner, member, outsider]) await env.DB.prepare("INSERT OR IGNORE INTO users (id,email,display_name,email_verified_at) VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(id, `${id}@test.com`, 'Billing').run()
  await env.DB.prepare('INSERT INTO organizations (id,name,slug,industry,country,created_by) VALUES (?,?,?,?,?,?)').bind(org, 'Billing', org, 'Software', 'US', owner).run()
  for (const [id, role] of [[owner, 'owner'], [member, 'member']]) await env.DB.prepare('INSERT INTO memberships (id,org_id,user_id,role) VALUES (?,?,?,?)').bind(crypto.randomUUID(), org, id, role).run()
  await env.DB.prepare('INSERT INTO customers (id,org_id,name,email) VALUES (?,?,?,?)').bind(customer, org, 'Customer', 'customer@test.com').run()
  await env.DB.prepare('INSERT INTO products (id,org_id,name) VALUES (?,?,?)').bind(product, org, 'Product').run()
  await env.DB.prepare('INSERT INTO plans (id,org_id,product_id,name,amount,"interval") VALUES (?,?,?,?,?,?)').bind(plan, org, product, 'Large', big, 'month').run()
})
describe('billing on real workerd D1', () => {
  it('serializes concurrent invoice replays, rejects key reuse and preserves gapless numbering', async () => {
    const key = crypto.randomUUID(), body = invoiceBody()
    const results = await Promise.all(Array.from({ length: 6 }, () => request('invoices', 'POST', body, key)))
    expect(results.map(r => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201])
    const records = await Promise.all(results.map(r => r.json<{ id: string }>()))
    expect(new Set(records.map(r => r.id)).size).toBe(1)
    const different = await request('invoices', 'POST', { ...body, memo: 'Different' }, key)
    expect(different.status).toBe(409)
    expect(await different.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } })
    const second = await request('invoices', 'POST', body, crypto.randomUUID())
    expect(await second.json()).toMatchObject({ number: expect.stringMatching(/-000002$/) as unknown })
    expect((await env.DB.prepare("SELECT count(*) AS n FROM audit_logs WHERE action='invoice.created' AND org_id=?").bind(org).first())?.n).toBe(2)
    expect((await request('invoices', 'POST', body)).status).toBe(422)
    expect((await request('invoices', 'POST', body, 'short')).status).toBe(422)
  })
  for (const collection of ['payments', 'escrows']) {
    it(`serializes same-key ${collection} retries and different-key races`, async () => {
      const firstInvoice = await invoice(), key = crypto.randomUUID()
      const retries = await Promise.all(Array.from({ length: 5 }, () => request(collection, 'POST', { invoiceId: firstInvoice.id }, key)))
      expect(retries.map(r => r.status).sort()).toEqual([200, 200, 200, 200, 201])
      const ids = await Promise.all(retries.map(async r => (await r.json<{ id: string }>()).id))
      expect(new Set(ids).size).toBe(1)
      const secondInvoice = await invoice()
      const results = await Promise.all(Array.from({ length: 5 }, () => request(collection, 'POST', { invoiceId: secondInvoice.id }, crypto.randomUUID())))
      expect(results.map(r => r.status).sort()).toEqual([201, 409, 409, 409, 409])
      expect((await env.DB.prepare(`SELECT count(*) AS n FROM ${collection} WHERE org_id=?`).bind(org).first())?.n).toBe(2)
      expect((await env.DB.prepare('SELECT count(*) AS n FROM audit_logs WHERE org_id=? AND action=?').bind(org, collection === 'payments' ? 'payment.created' : 'escrow.created').first())?.n).toBe(2)
      expect((await request(collection, 'POST', { invoiceId: secondInvoice.id }, key)).status).toBe(409)
    })
  }
  it('allows one live subscription and one invoice per subscription period under races', async () => {
    const subs = await Promise.all(Array.from({ length: 4 }, () => request('subscriptions', 'POST', { customerId: customer, planId: plan })))
    expect(subs.map(r => r.status).sort()).toEqual([201, 409, 409, 409])
    const sub = await subs.find(r => r.status === 201)!.json() as { id: string; amount: string }
    expect(sub.amount).toBe(big)
    const body = { ...invoiceBody(), subscriptionId: sub.id, periodStart: '2026-11-01T00:00:00.000Z' }
    const results = await Promise.all(Array.from({ length: 4 }, () => request('invoices', 'POST', body, crypto.randomUUID())))
    expect(results.map(r => r.status).sort()).toEqual([201, 409, 409, 409])
    expect((await env.DB.prepare('SELECT invoice_counter FROM organizations WHERE id=?').bind(org).first())?.invoice_counter).toBe(1)
    expect((await request('invoices', 'POST', { ...body, periodStart: undefined }, crypto.randomUUID())).status).toBe(422)
    expect((await request(`subscriptions/${sub.id}`, 'DELETE')).status).toBe(409)
    expect((await request(`subscriptions/${sub.id}`, 'PATCH', { status: 'active' })).status).toBe(422)
    expect((await request(`subscriptions/${sub.id}`, 'PATCH', { cancelAtPeriodEnd: true })).status).toBe(200)
    expect(await (await request(`subscriptions/${sub.id}`, 'PATCH', { status: 'canceled' })).json()).toMatchObject({ status: 'canceled', cancelAtPeriodEnd: true })
    expect((await request('subscriptions', 'POST', { customerId: customer, planId: plan })).status).toBe(201)
  })
  it('enforces draft/edit/finalize/void transitions without false audit entries', async () => {
    const i = await invoice(false), url = `invoices/${i.id}`
    expect((await request(url, 'PATCH', {})).status).toBe(400)
    expect((await request(url, 'PATCH', { lineItems: [{ description: 'Changed', quantity: 3, unitAmount: big }], memo: 'Updated' })).status).toBe(200)
    const race = await Promise.all([request(`${url}/finalize`, 'POST'), request(`${url}/finalize`, 'POST')])
    expect(race.map(r => r.status).sort()).toEqual([200, 409])
    expect((await request(url, 'PATCH', { memo: 'No' })).status).toBe(409)
    expect((await request(url, 'DELETE')).status).toBe(409)
    const p = await (await request('payments', 'POST', { invoiceId: i.id }, crypto.randomUUID())).json() as { id: string }
    expect((await request(`${url}/void`, 'POST')).status).toBe(409)
    expect((await request(`payments/${p.id}/cancel`, 'POST')).status).toBe(200)
    expect((await request(`payments/${p.id}/cancel`, 'POST')).status).toBe(409)
    const e = await (await request('escrows', 'POST', { invoiceId: i.id }, crypto.randomUUID())).json() as { id: string }
    expect((await request(`${url}/void`, 'POST')).status).toBe(409)
    expect((await request(`escrows/${e.id}`, 'DELETE')).status).toBe(204)
    expect((await request(`${url}/void`, 'POST')).status).toBe(200)
    expect((await request('payments', 'POST', { invoiceId: i.id }, crypto.randomUUID())).status).toBe(409)
    expect((await request(`${url}/void`, 'POST')).status).toBe(409)
    const actions = await env.DB.prepare('SELECT action FROM audit_logs WHERE resource_id=?').bind(i.id).all<{ action: string }>()
    expect(actions.results.map(a => a.action).sort()).toEqual(['invoice.created', 'invoice.finalized', 'invoice.updated', 'invoice.voided'])
  })
  it('rolls back records and invoice counter when mandatory audit insertion fails', async () => {
    await env.DB.prepare("CREATE TRIGGER billing_test_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='invoice.created' BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run()
    try {
      expect((await request('invoices', 'POST', invoiceBody(), crypto.randomUUID())).status).toBe(500)
      expect((await env.DB.prepare('SELECT count(*) AS n FROM invoices WHERE org_id=?').bind(org).first())?.n).toBe(0)
      expect((await env.DB.prepare('SELECT invoice_counter FROM organizations WHERE id=?').bind(org).first())?.invoice_counter).toBe(0)
    } finally { await env.DB.prepare('DROP TRIGGER billing_test_audit_failure').run() }
    const i = await invoice()
    await env.DB.prepare("CREATE TRIGGER billing_test_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action IN ('payment.created','escrow.created','invoice.voided','subscription.created') BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run()
    try {
      for (const collection of ['payments', 'escrows']) {
        expect((await request(collection, 'POST', { invoiceId: i.id }, crypto.randomUUID())).status).toBe(500)
        expect((await env.DB.prepare(`SELECT count(*) AS n FROM ${collection} WHERE org_id=?`).bind(org).first())?.n).toBe(0)
      }
      expect((await request(`invoices/${i.id}/void`, 'POST')).status).toBe(500)
      expect(await (await request(`invoices/${i.id}`)).json()).toMatchObject({ status: 'open' })
      expect((await request('subscriptions', 'POST', { customerId: customer, planId: plan })).status).toBe(500)
      expect((await env.DB.prepare('SELECT count(*) AS n FROM subscriptions WHERE org_id=?').bind(org).first())?.n).toBe(0)
    } finally { await env.DB.prepare('DROP TRIGGER billing_test_audit_failure').run() }
  })
  it('preserves escrow CRUD/history and append-only audit records', async () => {
    const i = await invoice()
    const e = await (await request('escrows', 'POST', { invoiceId: i.id, releaseAfterDays: 2 }, crypto.randomUUID())).json() as { id: string }
    expect((await request(`escrows/${e.id}`, 'PATCH', { releaseAfterDays: 5, status: 'funded' })).status).toBe(200)
    const history = await (await request(`escrows/${e.id}/history`)).json() as { action: string; metadata: object }[]
    expect(history.map(h => h.action).sort()).toEqual(['escrow.created', 'escrow.terms_updated'])
    expect(history.every(h => typeof h.metadata === 'object')).toBe(true)
    await expect(env.DB.prepare("UPDATE audit_logs SET action='tamper' WHERE resource_id=?").bind(e.id).run()).rejects.toThrow('append-only')
    await expect(env.DB.prepare('DELETE FROM audit_logs WHERE resource_id=?').bind(e.id).run()).rejects.toThrow('append-only')
    expect((await request(`escrows/${e.id}`, 'DELETE')).status).toBe(204)
    const actions = await env.DB.prepare('SELECT action FROM audit_logs WHERE resource_id=?').bind(e.id).all<{ action: string }>()
    expect(actions.results.map(a => a.action).sort()).toEqual(['escrow.created', 'escrow.discarded', 'escrow.terms_updated'])
  })
  it('rejects direct paid/funded changes and strips public chain-state fields', async () => {
    const i = await invoice()
    for (const collection of ['payments', 'escrows']) {
      const record = await (await request(collection, 'POST', { invoiceId: i.id }, crypto.randomUUID())).json() as { id: string }
      const sql = collection === 'payments' ? "UPDATE payments SET status='succeeded' WHERE id=?" : "UPDATE escrows SET status='funded' WHERE id=?"
      await expect(env.DB.prepare(sql).bind(record.id).run()).rejects.toThrow('chain_controlled')
      if (collection === 'escrows') {
        for (const status of ['funded', 'released', 'settled', 'refunded', 'disputed']) {
          expect((await request(`escrows/${record.id}`, 'PATCH', { status })).status).toBe(422)
          expect((await request(`escrows/${record.id}/${status}`, 'POST')).status).toBe(404)
        }
      }
    }
    await expect(env.DB.prepare("UPDATE invoices SET status='paid',amount_paid=total_amount WHERE id=?").bind(i.id).run()).rejects.toThrow('chain_controlled')
    expect((await request(`invoices/${i.id}`, 'PATCH', { status: 'paid', amountPaid: i.total })).status).toBe(400)
    expect(await (await request(`invoices/${i.id}`)).json()).toMatchObject({ status: 'open', amountPaid: '0' })
  })
  it('isolates tenant reads/references and enforces billing write permissions', async () => {
    const i = await invoice()
    for (const collection of ['subscriptions', 'invoices', 'payments', 'escrows']) {
      expect((await request(collection, 'GET', undefined, undefined, outsider)).status).toBe(404)
      expect((await request(collection, 'GET', undefined, undefined, 'anonymous')).status).toBe(401)
      expect((await request(collection, 'GET', undefined, undefined, member)).status).toBe(200)
    }
    expect((await request(`invoices/${i.id}/void`, 'POST', undefined, undefined, outsider)).status).toBe(404)
    for (const collection of ['subscriptions', 'payments', 'escrows']) expect((await request(collection, 'POST', { customerId: customer, planId: plan, invoiceId: i.id }, crypto.randomUUID(), member)).status).toBe(403)
    expect((await request('invoices', 'POST', invoiceBody(), crypto.randomUUID(), member)).status).toBe(201)
    expect((await request(`invoices/${crypto.randomUUID()}/void`, 'POST')).status).toBe(404)
    expect((await request('invoices/not-a-uuid')).status).toBe(404)
    expect((await request('payments', 'POST', { invoiceId: crypto.randomUUID() }, crypto.randomUUID())).status).toBe(404)
    expect((await request('invoices', 'POST', { ...invoiceBody(), customerId: crypto.randomUUID() }, crypto.randomUUID())).status).toBe(404)
    expect((await request('invoices?limit=1&offset=0')).status).toBe(200)
    expect((await request('invoices?limit=0')).status).toBe(422)
  })
  it('scopes every financial record and reference to the URL organization', async () => {
    const other = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO organizations (id,name,slug,industry,country,created_by) VALUES (?,?,?,?,?,?)').bind(other, 'Other', other, 'Software', 'US', owner).run()
    await env.DB.prepare("INSERT INTO memberships (id,org_id,user_id,role) VALUES (?,?,?,'owner')").bind(crypto.randomUUID(), other, owner).run()
    const i = await invoice()
    const sub = await (await request('subscriptions', 'POST', { customerId: customer, planId: plan })).json() as { id: string }
    const ids: [string, string][] = [['invoices', i.id], ['subscriptions', sub.id]]
    for (const collection of ['payments', 'escrows']) {
      const record = await (await request(collection, 'POST', { invoiceId: i.id }, crypto.randomUUID())).json() as { id: string }
      ids.push([collection, record.id])
      expect((await request(collection, 'POST', { invoiceId: i.id }, crypto.randomUUID(), owner, other)).status).toBe(404)
    }
    for (const [collection, id] of ids) {
      expect((await request(`${collection}/${id}`, 'GET', undefined, undefined, owner, other)).status).toBe(404)
      expect(await (await request(collection, 'GET', undefined, undefined, owner, other)).json()).toEqual([])
    }
    expect((await request('invoices', 'POST', invoiceBody(), crypto.randomUUID(), owner, other)).status).toBe(404)
    expect((await request('subscriptions', 'POST', { customerId: customer, planId: plan }, undefined, owner, other)).status).toBe(404)
    expect((await request(`invoices/${i.id}/void`, 'POST', undefined, undefined, owner, other)).status).toBe(404)
  })
  it('never leaves a live record on an invoice concurrently voided', async () => {
    for (const collection of ['payments', 'escrows']) {
      const i = await invoice()
      const [created, voided] = await Promise.all([request(collection, 'POST', { invoiceId: i.id }, crypto.randomUUID()), request(`invoices/${i.id}/void`, 'POST')])
      expect([created.status, voided.status]).toSatisfy((statuses: number[]) => (statuses[0] === 201 && statuses[1] === 409) || (statuses[0] === 409 && statuses[1] === 200))
      const state = await env.DB.prepare('SELECT status FROM invoices WHERE id=?').bind(i.id).first<{ status: string }>()
      const records = await env.DB.prepare(`SELECT count(*) AS n FROM ${collection} WHERE invoice_id=?`).bind(i.id).first<{ n: number }>()
      expect(state?.status === 'void' ? records?.n === 0 : records?.n === 1).toBe(true)
    }
  })
  it('supports deleting unused draft invoices and incomplete/canceled subscriptions', async () => {
    const i = await invoice(false)
    expect((await request(`invoices/${i.id}`, 'DELETE')).status).toBe(204)
    expect((await request(`invoices/${i.id}`)).status).toBe(404)
    const sub = await (await request('subscriptions', 'POST', { customerId: customer, planId: plan })).json() as { id: string }
    expect((await request(`subscriptions/${sub.id}`, 'DELETE')).status).toBe(204)
    const next = await (await request('subscriptions', 'POST', { customerId: customer, planId: plan })).json() as { id: string }
    expect((await request(`subscriptions/${next.id}`, 'PATCH', { status: 'canceled' })).status).toBe(200)
    expect((await request(`subscriptions/${next.id}`, 'DELETE')).status).toBe(204)
    const deleted = await env.DB.prepare("SELECT action FROM audit_logs WHERE org_id=? AND action LIKE '%.deleted'").bind(org).all()
    expect(deleted.results).toHaveLength(3)
  })
  it('returns validation errors for malformed, numeric and out-of-range invoice amounts', async () => {
    for (const unitAmount of ['abc', '1e3', '1.5', '01', '-1', '0', '', '9223372036854775808', 123]) {
      const body = { ...invoiceBody(), lineItems: [{ description: 'Invalid', quantity: 1, unitAmount }] }
      const r = await request('invoices', 'POST', body, crypto.randomUUID())
      expect(r.status, String(unitAmount)).toBe(422)
    }
  })
  it('computes invoice totals and payment/escrow amounts exactly beyond 2^53', async () => {
    const i = await invoice()
    expect(i.total).toBe('18014398509481986')
    const row = await env.DB.prepare('SELECT total_amount,typeof(total_amount) AS kind FROM invoices WHERE id=?').bind(i.id).first()
    expect(row).toEqual({ total_amount: i.total, kind: 'text' })
    for (const collection of ['payments', 'escrows']) {
      const r = await request(collection, 'POST', { invoiceId: i.id, status: 'succeeded', amount: '1', txHash: 'fake', contractAddress: 'fake' }, crypto.randomUUID())
      expect(r.status, await r.clone().text()).toBe(201)
      expect(await r.json()).toMatchObject({ amount: i.total, status: collection === 'payments' ? 'pending' : 'pending_funding' })
    }
    expect((await request('invoices', 'POST', invoiceBody('9223372036854775807'), crypto.randomUUID())).status).toBe(422)
  })
})
