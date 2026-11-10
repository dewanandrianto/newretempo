import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChainSnapshot, VerifiedChainEvent } from '../shared/chain'
import { formatBaseUnits } from '../shared/money'
import { liveBillingService } from '../src/services/billing/liveBillingService'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RevenueCard } from '../src/features/dashboard/pages/OverviewPage'
import { setActiveOrg } from '../src/services/api/activeOrg'
import type { ApiInvoice, ApiSubscription } from '../shared/types'
import { buildLiveEscrow, buildLiveDisputes, buildLiveLedger, buildLiveOverview, type LiveBillingRecords } from '../src/services/billing/chainMappers'

const empty: ChainSnapshot = {
  configuration: { chainId: 5042002, mode: 'disabled', configured: false, rpcUrl: 'https://rpc.testnet.arc.io', explorerUrl: 'https://explorer.testnet.arc.io', usdc: '0x3600000000000000000000000000000000000000', usdcDecimals: 6, manager: null, escrow: null, startBlock: null },
  cursor: null, bindings: [], events: [], projections: [],
}
const records: LiveBillingRecords = { orgId: 'org-1', plans: [], subscriptions: [], invoices: [], escrows: [] }
const now = new Date('2026-11-08T00:00:00.000Z')

void test('live service reads verified snapshots and fails closed for legacy public getters and network errors', async () => {
  const original = globalThis.fetch
  const paths: string[] = []
  setActiveOrg({ id: 'org-1', name: 'Merchant' })
  globalThis.fetch = (input: string | URL | Request) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; paths.push(path)
    return Promise.resolve(Response.json(path.endsWith('/chain/snapshot') ? empty : []))
  }
  try {
    assert.equal((await liveBillingService.getOverview()).data.totalRevenue, '0.00')
    assert.deepEqual((await liveBillingService.listTransactions()).data, [])
    assert.deepEqual((await liveBillingService.listDisputes()).data, [])
    assert.ok(paths.includes('/api/orgs/org-1/chain/snapshot'))
    assert.equal((await liveBillingService.getCheckoutSession('legacy-id')).data, null)
    assert.equal((await liveBillingService.getInvoice('legacy-id')).data, null)
    await assert.rejects(liveBillingService.getPortal(), /wallet|portal/i)
    globalThis.fetch = () => Promise.resolve(new Response('unavailable', { status: 503 }))
    await assert.rejects(liveBillingService.getOverview())
  } finally { globalThis.fetch = original; setActiveOrg(null) }
})

void test('revenue card totals exact base units rather than dimensionless chart coordinates', () => {
  const data = buildLiveOverview(empty, records, now)
  data.revenueSeries = [{ label: 'Nov', value: 900, baseUnits: '1234567' }, { label: 'Oct', value: 450, baseUnits: '2000000' }]
  const html = renderToStaticMarkup(createElement(RevenueCard, { data }))
  assert.ok(html.includes('3.234567'), html)
  assert.ok(!html.includes('1,350'), html)
})

void test('live financial pages have no sample claims or invented deployment state', () => {
  for (const file of ['OverviewPage.tsx', 'MoneyPages.tsx', 'EscrowPage.tsx']) {
    const source = readFileSync(new URL(`../src/features/dashboard/pages/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /Sample ledger|Sample figure|No RETEMPO escrow contract is deployed|arrives with the smart contract phase|DemoNotice/)
  }
})

void test('empty live data returns honest zero/empty metrics, never sample business records', () => {
  const result = buildLiveOverview(empty, records, now)
  assert.equal(result.totalRevenue, '0.00')
  assert.equal(result.mrr, '0.00')
  assert.equal(result.escrowBalance, '0.00')
  assert.equal(result.activeSubscriptions, 0)
  assert.equal(result.pendingInvoices, 0)
  assert.deepEqual(result.activity, [])
  assert.deepEqual(result.recent, [])
  assert.deepEqual(result.planMix, [])
  assert.equal(result.revenueSeries.length, 12)
  assert.ok(result.revenueSeries.every(point => point.value === 0))
})

const event = (overrides: Partial<VerifiedChainEvent> = {}): VerifiedChainEvent => ({
  id: 'fixture-event', chainId: 5042002, address: '0x1111111111111111111111111111111111111111',
  blockNumber: '5', blockHash: `0x${'1'.repeat(64)}`, transactionHash: `0x${'2'.repeat(64)}`,
  transactionIndex: 0, logIndex: 0, timestamp: '2026-11-07T00:00:00.000Z',
  name: 'SubscriptionPaymentProcessed', args: { amount: '900719925474099' }, ...overrides,
})

void test('verified gross payments stay exact above 2^53 and never double-count a routed escrow or duplicate log', () => {
  const payments = Array.from({ length: 11 }, (_, index) => event({ id: `payment-${index}`, logIndex: index }))
  const routed = event({ id: 'hold', logIndex: 20, name: 'EscrowFunded', args: { amount: '900719925474099', viaManager: true } })
  const duplicate = { ...payments[0], id: 'a-different-client-id-for-the-same-log' }
  const result = buildLiveOverview({ ...empty, events: [...payments, routed, duplicate] }, records, now)
  const total = 11n * 900719925474099n
  assert.equal(result.totalRevenue, formatBaseUnits(total))
  assert.equal(result.revenueSeries[result.revenueSeries.length - 1]?.baseUnits, total.toString())
  assert.ok(result.revenueSeries.every(point => Number.isFinite(point.value) && point.value >= 0 && point.value <= 900))
})

const subscription = (overrides: Partial<ApiSubscription> = {}): ApiSubscription => ({
  id: 'sub', customerId: 'customer', customerName: 'Verified customer', planId: 'plan', planName: 'Exact weekly',
  status: 'active', amount: '10000001', interval: 'week', currentPeriodStart: '2026-11-01T00:00:00.000Z',
  currentPeriodEnd: '2026-11-08T00:00:00.000Z', cancelAtPeriodEnd: false, createdAt: '2026-11-01T00:00:00.000Z', ...overrides,
})
const invoice = (overrides: Partial<ApiInvoice> = {}): ApiInvoice => ({
  id: 'invoice', number: 'INV-1', customerId: 'customer', customerName: 'Verified customer', customerEmail: 'fixture@example.test',
  subscriptionId: 'sub', status: 'open', total: '12340000', amountPaid: '40000', lineItems: [], memo: '',
  issuedAt: '2026-11-01T00:00:00.000Z', dueAt: '2026-11-09T00:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z', ...overrides,
})

void test('live list reads request every limit-100 offset page', async () => {
  const original = globalThis.fetch
  const paths: string[] = []
  setActiveOrg({ id: 'org-1', name: 'Merchant' })
  globalThis.fetch = (input: string | URL | Request) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; paths.push(path)
    const offset = Number(new URL(path, 'http://localhost').searchParams.get('offset') ?? 0)
    return Promise.resolve(Response.json(offset === 0 ? Array.from({ length: 100 }, (_, i) => invoice({ id: `invoice-${i}` })) : [invoice({ id: 'last' })]))
  }
  try {
    const result = await liveBillingService.listInvoices()
    assert.equal(result.data.length, 101)
    assert.deepEqual(paths, ['/api/orgs/org-1/invoices?limit=100&offset=0', '/api/orgs/org-1/invoices?limit=100&offset=100'])
  } finally { globalThis.fetch = original; setActiveOrg(null) }
})

void test('run rate and outstanding quotes use exact active/open records without counting canceled or draft values', () => {
  const input = { ...records, subscriptions: [subscription(), subscription({ id: 'canceled', status: 'canceled', amount: '9007199254740993' })], invoices: [invoice(), invoice({ id: 'draft', status: 'draft' }), invoice({ id: 'paid', status: 'paid' })] }
  const result = buildLiveOverview(empty, input, now)
  assert.equal(result.activeSubscriptions, 1)
  assert.equal(result.mrr, formatBaseUnits(10000001n * 52n / 12n))
  assert.equal(result.pendingInvoices, 1)
  assert.equal(result.pendingInvoicesAmount, '12.30')
  assert.deepEqual(result.planMix, [{ label: 'Exact weekly', value: 1 }])
})

void test('live ledger uses canonical credit events and scoped payout projections without multiplying cash movements', () => {
  const events = [
    event({ logIndex: 0, args: { amount: '100000000', customer: 'Customer wallet' } }),
    event({ logIndex: 1, name: 'EscrowFunded', args: { amount: '100000000', viaManager: true } }),
    event({ logIndex: 2, name: 'VestedClaimed', args: { amount: '40000000', merchant: 'Merchant wallet' } }),
    event({ logIndex: 3, name: 'RefundCredited', args: { amount: '30000000', customer: 'Customer wallet' } }),
    event({ logIndex: 4, name: 'DisputeResolved', args: { merchantAmount: '10000000', customerAmount: '30000000' } }),
    event({ logIndex: 5, name: 'Withdrawn', args: { amount: '70000000', account: 'Merchant wallet', to: 'Payout wallet' } }),
    event({ logIndex: 6, name: 'EscrowFunded', args: { amount: '5000000', viaManager: false, payer: 'Direct customer' } }),
  ]
  const snapshot: ChainSnapshot = { ...empty, events, projections: [
    { orgId: 'org-1', kind: 'ledger', recordId: 'scoped-payout', key: `0x${'3'.repeat(64)}`, state: 'succeeded', blockNumber: '5', transactionHash: events[0].transactionHash, values: { kind: 'payout', direction: 'out', amount: '40000000', counterparty: 'Payout wallet', createdAt: events[0].timestamp } },
    { orgId: 'other-org', kind: 'ledger', recordId: 'foreign-payout', key: `0x${'4'.repeat(64)}`, state: 'succeeded', blockNumber: '5', transactionHash: events[0].transactionHash, values: { kind: 'payout', direction: 'out', amount: '30000000', counterparty: 'Other wallet', createdAt: events[0].timestamp } },
  ] }
  const ledger = buildLiveLedger(snapshot, 'org-1')
  assert.equal(ledger.filter(row => row.kind === 'refund').length, 1)
  assert.deepEqual(ledger.filter(row => row.kind === 'payout').map(row => row.amount), ['40.00'])
  assert.equal(ledger.filter(row => row.kind === 'payment').length, 2)
  assert.equal(new Set(ledger.map(row => row.id)).size, ledger.length)
  assert.ok(ledger.every(row => row.transactionHash === events[0].transactionHash && row.status === 'succeeded'))
  assert.equal(buildLiveOverview(snapshot, records, now).totalRevenue, '105.00')
})

void test('resolved dispute retains its verified opening amount instead of a cleared frozen balance', () => {
  const key = `0x${'3'.repeat(64)}` as const
  const resolved: ChainSnapshot = { ...empty, events: [event({ name: 'DisputeOpened', args: { escrowKey: key, amount: '30000001' } })], projections: [{ orgId: 'org-1', kind: 'dispute', recordId: 'escrow-1', key, state: 'resolved', blockNumber: '5', transactionHash: null, values: { frozen: '0', merchantResponded: true, disputedAt: now.toISOString(), respondBy: now.toISOString() } }] }
  assert.equal(buildLiveDisputes(resolved, records)[0]?.amount, '30.000001')
  assert.equal(buildLiveDisputes(resolved, records)[0]?.status, 'resolved')
})

void test('escrow uses pinned balance and claimable getters, not original amount or elapsed time', () => {
  const projection: ChainSnapshot['projections'][number] = {
    orgId: 'org-1', kind: 'escrow', recordId: 'escrow-1', key: `0x${'3'.repeat(64)}`, state: 'active',
    blockNumber: '5', transactionHash: null,
    values: { amount: '100000000', balance: '60000001', claimable: '20000001', dispute: 'none', outcome: 'none', vestEnd: '2020-01-01T00:00:00.000Z' },
  }
  const snapshot = { ...empty, projections: [projection, { ...projection, orgId: 'other-org', recordId: 'foreign' }] }
  assert.equal(buildLiveEscrow(snapshot, records).held, '60.000001')
  assert.equal(buildLiveEscrow(snapshot, records).releasable, '20.000001')
  assert.equal(buildLiveOverview(snapshot, records, now).escrowBalance, '60.000001')
  assert.equal(buildLiveEscrow(snapshot, records).holds.length, 1)
  const frozen = { ...projection, values: { ...projection.values, dispute: 'open', frozen: '60000001', claimable: '0', disputedAt: now.toISOString(), respondBy: '2026-11-10T00:00:00.000Z', merchantResponded: false } }
  const disputed = { ...empty, projections: [frozen, { ...frozen, kind: 'dispute' as const, state: 'open' }] }
  assert.equal(buildLiveEscrow(disputed, records).disputed, '60.000001')
  assert.equal(buildLiveEscrow(disputed, records).releasable, '0.00')
  assert.equal(buildLiveDisputes(disputed, records)[0]?.status, 'needs_response')
  assert.equal(buildLiveDisputes(disputed, records)[0]?.respondBy, '2026-11-10T00:00:00.000Z')
  assert.throws(() => buildLiveEscrow({ ...empty, projections: [{ ...projection, values: { ...projection.values, claimable: null } }] }, records), /exact base-unit/)
})
