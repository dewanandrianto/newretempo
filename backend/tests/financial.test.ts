import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { runAuthoritative } from '../src/services/chainEvents'
import { createMerchant, idempotencyHeader, seedDataset, type Dataset, type Merchant } from './fixtures'
import { createTestEnv, type TestEnv } from './helpers'

let env: TestEnv
let m: Merchant
let base: string

beforeAll(async () => {
  env = await createTestEnv()
  m = await createMerchant(env, 'Fin')
  base = `/api/orgs/${m.orgId}`
})
afterAll(async () => {
  await env.close()
})

type Json = Record<string, unknown>
const due = () => new Date(Date.now() + 14 * 86_400_000).toISOString()
const item = (unitAmount: string, quantity = 1) => ({ description: 'Line', quantity, unitAmount })

describe('integer base-unit money', () => {
  test('every financial column is BIGINT; none is float or numeric', async () => {
    const rows = (await env.db`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('amount', 'total_amount', 'amount_paid', 'max_amount_per_period')`) as { table_name: string; column_name: string; data_type: string }[]
    expect(rows.length).toBeGreaterThanOrEqual(8)
    for (const r of rows) expect(r.data_type).toBe('bigint')
  })

  test('large amounts round-trip exactly (beyond 2^53)', async () => {
    const product = await m.client.post<{ id: string }>(`${base}/products`, { name: 'Big' })
    const big = '9007199254740993'
    const plan = await m.client.post<{ amount: string }>(`${base}/plans`, { productId: product.body.id, name: 'Huge', amount: big, interval: 'year' })
    expect(plan.status).toBe(201)
    expect(plan.body.amount).toBe(big)
  })

  test('amounts must be positive integer strings in range', async () => {
    const product = await m.client.post<{ id: string }>(`${base}/products`, { name: 'Strict' })
    for (const amount of ['0', '-5', '1.5', '1e6', '9223372036854775808', 'abc', '']) {
      const res = await m.client.post(`${base}/plans`, { productId: product.body.id, name: `P ${amount}`, amount, interval: 'month' })
      expect(res.status).toBe(422)
    }
    expect((await m.client.post(`${base}/plans`, { productId: product.body.id, name: 'Numeric', amount: 5_000_000, interval: 'month' })).status).toBe(422)
  })

  test('database constraints reject non-positive amounts even when the API is bypassed', async () => {
    const product = await m.client.post<{ id: string }>(`${base}/products`, { name: 'Raw' })
    let failed = false
    try {
      await env.db`INSERT INTO plans (org_id, product_id, name, amount, "interval") VALUES (${m.orgId}, ${product.body.id}, 'Zero', 0, 'month')`
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })

  test('invoice totals are exact integer sums', async () => {
    const customer = await m.client.post<{ id: string }>(`${base}/customers`, { name: 'Sum', email: 'sum@example.test' })
    const res = await m.client.post<{ total: string }>(
      `${base}/invoices`,
      { customerId: customer.body.id, dueAt: due(), lineItems: [item('1', 3), item('33333333', 3), item('9007199254740993', 2)] },
      idempotencyHeader(),
    )
    expect(res.status).toBe(201)
    expect(res.body.total).toBe((3n + 99_999_999n + 18_014_398_509_481_986n).toString())
  })

  test('an invoice total beyond BIGINT is rejected', async () => {
    const customer = await m.client.post<{ id: string }>(`${base}/customers`, { name: 'Over', email: 'over@example.test' })
    const res = await m.client.post(
      `${base}/invoices`,
      { customerId: customer.body.id, dueAt: due(), lineItems: [item('9223372036854775807', 2)] },
      idempotencyHeader(),
    )
    expect(res.status).toBe(422)
  })
})

describe('idempotency and duplicate prevention', () => {
  test('creating financial records requires an Idempotency-Key', async () => {
    const customer = await m.client.post<{ id: string }>(`${base}/customers`, { name: 'NoKey', email: 'nokey@example.test' })
    const body = { customerId: customer.body.id, dueAt: due(), lineItems: [item('1000000')] }
    expect((await m.client.post(`${base}/invoices`, body)).status).toBe(422)
    expect((await m.client.post(`${base}/invoices`, body, { 'Idempotency-Key': 'short' })).status).toBe(422)
  })

  test('the same key and body creates one invoice; a replay returns it with 200', async () => {
    const customer = await m.client.post<{ id: string }>(`${base}/customers`, { name: 'Replay', email: 'replay@example.test' })
    const headers = idempotencyHeader()
    const body = { customerId: customer.body.id, dueAt: due(), lineItems: [item('5000000')] }
    const first = await m.client.post<{ id: string; number: string }>(`${base}/invoices`, body, headers)
    const second = await m.client.post<{ id: string; number: string }>(`${base}/invoices`, body, headers)
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.body.id).toBe(first.body.id)
    const count = (await env.db`SELECT count(*)::int AS n FROM invoices WHERE customer_id = ${customer.body.id}`) as { n: number }[]
    expect(count[0].n).toBe(1)
  })

  test('reusing a key with a different request is refused', async () => {
    const customer = await m.client.post<{ id: string }>(`${base}/customers`, { name: 'Reuse', email: 'reuse@example.test' })
    const headers = idempotencyHeader()
    await m.client.post(`${base}/invoices`, { customerId: customer.body.id, dueAt: due(), lineItems: [item('1000000')] }, headers)
    const res = await m.client.post<{ error: { code: string } }>(`${base}/invoices`, { customerId: customer.body.id, dueAt: due(), lineItems: [item('2000000')] }, headers)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('idempotency_key_reused')
  })

  test('concurrent retries with one key create exactly one invoice', async () => {
    const customer = await m.client.post<{ id: string }>(`${base}/customers`, { name: 'Race', email: 'race@example.test' })
    const headers = idempotencyHeader()
    const body = { customerId: customer.body.id, dueAt: due(), lineItems: [item('7000000')] }
    const results = await Promise.all(Array.from({ length: 6 }, () => m.client.post<{ id: string }>(`${base}/invoices`, body, headers)))
    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true)
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1)
    const count = (await env.db`SELECT count(*)::int AS n FROM invoices WHERE customer_id = ${customer.body.id}`) as { n: number }[]
    expect(count[0].n).toBe(1)
  })

  test('invoice numbers are sequential with no gaps per organization', async () => {
    const solo = await createMerchant(env, 'Counter')
    const customer = await solo.client.post<{ id: string }>(`/api/orgs/${solo.orgId}/customers`, { name: 'C', email: 'c@example.test' })
    const numbers: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await solo.client.post<{ number: string }>(`/api/orgs/${solo.orgId}/invoices`, { customerId: customer.body.id, dueAt: due(), lineItems: [item('1000000')] }, idempotencyHeader())
      numbers.push(r.body.number.split('-')[2])
    }
    expect(numbers).toEqual(['000001', '000002', '000003'])
  })

  test('one invoice per subscription billing period', async () => {
    const solo = await createMerchant(env, 'Period')
    const d: Dataset = await seedDataset(solo, { tag: 'period' })
    const periodStart = '2026-12-01T00:00:00.000Z'
    const body = { customerId: d.customerId, subscriptionId: d.subscriptionId, periodStart, dueAt: due(), lineItems: [item('99000000')] }
    expect((await solo.client.post(`/api/orgs/${solo.orgId}/invoices`, body, idempotencyHeader())).status).toBe(201)
    const dup = await solo.client.post<{ error: { code: string } }>(`/api/orgs/${solo.orgId}/invoices`, body, idempotencyHeader())
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('duplicate_invoice')
    const noPeriod = await solo.client.post(`/api/orgs/${solo.orgId}/invoices`, { ...body, periodStart: undefined }, idempotencyHeader())
    expect(noPeriod.status).toBe(422)
  })
})

describe('payment records', () => {
  test('only open invoices accept a payment record; it starts pending with no chain data', async () => {
    const d = await seedDataset(m, { tag: 'pay1' })
    const draftCustomer = await m.client.post<{ id: string }>(`${base}/customers`, { name: 'Draft', email: 'draft@example.test' })
    const draft = await m.client.post<{ id: string }>(`${base}/invoices`, { customerId: draftCustomer.body.id, dueAt: due(), lineItems: [item('1000000')] }, idempotencyHeader())
    expect((await m.client.post(`${base}/payments`, { invoiceId: draft.body.id }, idempotencyHeader())).status).toBe(409)

    const res = await m.client.post<Json>(`${base}/payments`, { invoiceId: d.invoiceId, status: 'succeeded', txHash: '0x' + 'a'.repeat(64), amount: '1' }, idempotencyHeader())
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('pending')
    expect(res.body.txHash).toBeNull()
    expect(res.body.amount).toBe('99000000')
  })

  test('a second payment for the same invoice is blocked; the same key replays', async () => {
    const d = await seedDataset(m, { tag: 'pay2' })
    const headers = idempotencyHeader()
    const first = await m.client.post<{ id: string }>(`${base}/payments`, { invoiceId: d.invoiceId }, headers)
    const replay = await m.client.post<{ id: string }>(`${base}/payments`, { invoiceId: d.invoiceId }, headers)
    expect(replay.status).toBe(200)
    expect(replay.body.id).toBe(first.body.id)
    expect((await m.client.post(`${base}/payments`, { invoiceId: d.invoiceId }, idempotencyHeader())).status).toBe(409)

    // After canceling the pending record a new one may be created.
    expect((await m.client.post(`${base}/payments/${first.body.id}/cancel`)).status).toBe(200)
    expect((await m.client.post(`${base}/payments`, { invoiceId: d.invoiceId }, idempotencyHeader())).status).toBe(201)
  })

  test('concurrent payment requests with different keys create exactly one live payment', async () => {
    const d = await seedDataset(m, { tag: 'pay3' })
    const results = await Promise.all(Array.from({ length: 5 }, () => m.client.post(`${base}/payments`, { invoiceId: d.invoiceId }, idempotencyHeader())))
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    const live = (await env.db`SELECT count(*)::int AS n FROM payments WHERE invoice_id = ${d.invoiceId} AND status IN ('pending','processing','succeeded')`) as { n: number }[]
    expect(live[0].n).toBe(1)
  })
})

describe('escrow security: status is chain-controlled', () => {
  test('records are created as pending_funding and request bodies cannot choose the status', async () => {
    const d = await seedDataset(m, { tag: 'esc1' })
    const res = await m.client.post<Json>(`${base}/escrows`, { invoiceId: d.invoiceId, status: 'released', fundedTxHash: '0x' + 'b'.repeat(64), contractAddress: '0x' + 'c'.repeat(40) }, idempotencyHeader())
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('pending_funding')
    expect(res.body.contractAddress).toBeNull()
    expect(res.body.amount).toBe('99000000')
  })

  test('no API route can mark an escrow funded, released, refunded or settled', async () => {
    const d = await seedDataset(m, { tag: 'esc2' })
    const esc = await m.client.post<{ id: string }>(`${base}/escrows`, { invoiceId: d.invoiceId }, idempotencyHeader())
    const url = `${base}/escrows/${esc.body.id}`
    for (const status of ['funded', 'released', 'refunded', 'settled', 'disputed']) {
      expect((await m.client.patch(url, { status })).status).toBe(422)
      expect((await m.client.patch(url, { status, releaseAfterDays: 1 })).status).toBe(200)
      expect((await m.client.post(`${url}/${status}`)).status).toBe(404)
    }
    const row = (await env.db`SELECT status, funded_tx_hash, settled_tx_hash FROM escrows WHERE id = ${esc.body.id}`) as { status: string; funded_tx_hash: string | null; settled_tx_hash: string | null }[]
    expect(row[0].status).toBe('pending_funding')
    expect(row[0].funded_tx_hash).toBeNull()
  })

  test('the database refuses direct state changes outside the verified-event path', async () => {
    const d = await seedDataset(m, { tag: 'esc3' })
    const esc = await m.client.post<{ id: string }>(`${base}/escrows`, { invoiceId: d.invoiceId }, idempotencyHeader())
    const pay = await m.client.post<{ id: string }>(`${base}/payments`, { invoiceId: d.invoiceId }, idempotencyHeader())

    const attempts: [string, () => Promise<unknown>][] = [
      ['escrow funded', () => env.db`UPDATE escrows SET status = 'funded' WHERE id = ${esc.body.id}`],
      ['escrow settled', () => env.db`UPDATE escrows SET status = 'settled' WHERE id = ${esc.body.id}`],
      ['escrow chain ref', () => env.db`UPDATE escrows SET funded_tx_hash = ${'0x' + 'a'.repeat(64)} WHERE id = ${esc.body.id}`],
      ['payment succeeded', () => env.db`UPDATE payments SET status = 'succeeded', tx_hash = ${'0x' + 'a'.repeat(64)}, confirmed_at = now() WHERE id = ${pay.body.id}`],
      ['payment processing', () => env.db`UPDATE payments SET status = 'processing' WHERE id = ${pay.body.id}`],
      ['invoice paid', () => env.db`UPDATE invoices SET status = 'paid', amount_paid = total_amount WHERE id = ${d.invoiceId}`],
      ['ledger insert', () => env.db`INSERT INTO transactions (org_id, kind, direction, amount, chain_id, tx_hash, log_index, block_number, occurred_at) VALUES (${m.orgId}, 'payment', 'in', 1, 5042002, ${'0x' + 'd'.repeat(64)}, 0, 1, now())`],
      ['escrow inserted funded', () => env.db`INSERT INTO escrows (org_id, invoice_id, customer_id, amount, status, chain_id, idempotency_key, request_hash) VALUES (${m.orgId}, ${d.invoiceId}, ${d.customerId}, 1, 'funded', 5042002, 'raw-insert-key-1', 'x')`],
    ]
    for (const [label, run] of attempts) {
      let code = ''
      try {
        await run()
      } catch (err) {
        code = String((err as { errno?: string; code?: string }).errno ?? (err as { code?: string }).code)
      }
      expect({ label, code }).toEqual({ label, code: '42501' })
    }
  })

  test('only an explicit authoritative transaction can change escrow state (Phase 3 seam)', async () => {
    const d = await seedDataset(m, { tag: 'esc4' })
    const esc = await m.client.post<{ id: string }>(`${base}/escrows`, { invoiceId: d.invoiceId }, idempotencyHeader())
    // Test-only: simulates what a verified chain event processor will be allowed to do.
    await runAuthoritative(env.db, async (tx) => {
      await tx`UPDATE escrows SET status = 'funded' WHERE id = ${esc.body.id}`
    })
    const got = await m.client.get<{ status: string }>(`${base}/escrows/${esc.body.id}`)
    expect(got.body.status).toBe('funded')
    // A funded escrow can no longer be discarded or re-termed through the API.
    expect((await m.client.del(`${base}/escrows/${esc.body.id}`)).status).toBe(409)
    expect((await m.client.patch(`${base}/escrows/${esc.body.id}`, { releaseAfterDays: 3 })).status).toBe(409)
  })

  test('one live escrow per invoice and unfunded records can be discarded', async () => {
    const d = await seedDataset(m, { tag: 'esc5' })
    const first = await m.client.post<{ id: string }>(`${base}/escrows`, { invoiceId: d.invoiceId }, idempotencyHeader())
    expect((await m.client.post(`${base}/escrows`, { invoiceId: d.invoiceId }, idempotencyHeader())).status).toBe(409)
    expect((await m.client.del(`${base}/escrows/${first.body.id}`)).status).toBe(204)
  })

  test('every escrow change leaves an audit trail, and the trail is append-only', async () => {
    const d = await seedDataset(m, { tag: 'esc6' })
    const esc = await m.client.post<{ id: string }>(`${base}/escrows`, { invoiceId: d.invoiceId, releaseAfterDays: 2 }, idempotencyHeader())
    await m.client.patch(`${base}/escrows/${esc.body.id}`, { releaseAfterDays: 5 })
    await m.client.del(`${base}/escrows/${esc.body.id}`)
    const history = await env.db`SELECT action FROM audit_logs WHERE resource_type = 'escrow' AND resource_id = ${esc.body.id} ORDER BY created_at, id`
    expect((history as { action: string }[]).map((h) => h.action)).toEqual(['escrow.created', 'escrow.terms_updated', 'escrow.discarded'])

    let blocked = 0
    for (const run of [() => env.db`UPDATE audit_logs SET action = 'tampered' WHERE resource_id = ${esc.body.id}`, () => env.db`DELETE FROM audit_logs WHERE resource_id = ${esc.body.id}`]) {
      try {
        await run()
      } catch {
        blocked += 1
      }
    }
    expect(blocked).toBe(2)
  })

  test('escrow history is available per record', async () => {
    const d = await seedDataset(m, { tag: 'esc7' })
    const esc = await m.client.post<{ id: string }>(`${base}/escrows`, { invoiceId: d.invoiceId }, idempotencyHeader())
    const history = await m.client.get<{ action: string }[]>(`${base}/escrows/${esc.body.id}/history`)
    expect(history.body.map((h) => h.action)).toContain('escrow.created')
  })
})

describe('subscriptions, wallets and API keys', () => {
  test('subscriptions start incomplete and merchants cannot activate them', async () => {
    const d = await seedDataset(m, { tag: 'sub1' })
    const sub = await m.client.get<{ status: string }>(`${base}/subscriptions/${d.subscriptionId}`)
    expect(sub.body.status).toBe('incomplete')
    expect((await m.client.patch(`${base}/subscriptions/${d.subscriptionId}`, { status: 'active' })).status).toBe(422)
    expect((await m.client.patch(`${base}/subscriptions/${d.subscriptionId}`, { status: 'canceled' })).status).toBe(200)
  })

  test('wallet addresses are validated, lowercased and marked unverified', async () => {
    const mixed = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
    const ok = await m.client.post<{ address: string; verified: boolean }>(`${base}/wallets`, { purpose: 'payout', address: mixed, label: 'Treasury' })
    expect(ok.status).toBe(201)
    expect(ok.body.address).toBe(mixed.toLowerCase())
    expect(ok.body.verified).toBe(false)
    expect((await m.client.post(`${base}/wallets`, { purpose: 'payout', address: '0x123' })).status).toBe(422)
    expect((await m.client.post(`${base}/wallets`, { purpose: 'payout', address: mixed })).status).toBe(409)
  })

  test('API key secrets are shown once and stored only as a hash', async () => {
    const created = await m.client.post<{ secret: string; prefix: string; id: string }>(`${base}/api-keys`, { name: 'CI', scopes: ['read'] })
    expect(created.status).toBe(201)
    expect(created.body.secret.startsWith(created.body.prefix)).toBe(true)
    const list = await m.client.get<Json[]>(`${base}/api-keys`)
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret)
    const row = (await env.db`SELECT key_hash FROM api_keys WHERE id = ${created.body.id}`) as { key_hash: string }[]
    expect(row[0].key_hash).not.toContain(created.body.secret)
    expect(row[0].key_hash).toMatch(/^[0-9a-f]{64}$/)
    expect((await m.client.del(`${base}/api-keys/${created.body.id}`)).status).toBe(204)
    expect((await m.client.get<{ revokedAt: string | null }[]>(`${base}/api-keys`)).body.find((k) => (k as unknown as { id: string }).id === created.body.id)?.revokedAt).not.toBeNull()
  })

  test('audit logs never contain credentials', async () => {
    const key = await m.client.post<{ secret: string }>(`${base}/api-keys`, { name: 'audit-check' })
    const rows = (await env.db`SELECT metadata::text AS text FROM audit_logs`) as { text: string }[]
    const dump = rows.map((r) => r.text).join('\n')
    expect(dump).not.toContain('correct horse')
    expect(dump).not.toContain(key.body.secret)
    expect(dump).not.toContain(key.body.secret.split('.')[1])
  })
})
