import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import type { ApiCustomer, ApiPayment, ApiInvoice } from '../shared/types'
import { toCustomer, toInvoice } from '../src/services/billing/mappers'

const customer: ApiCustomer = { id: 'customer', name: 'Actual customer', email: 'fixture@example.test', company: '', status: 'active', createdAt: '2026-11-01T00:00:00.000Z' }
const payment = (overrides: Partial<ApiPayment> = {}): ApiPayment => ({ id: 'payment', invoiceId: 'invoice', invoiceNumber: 'INV-1', customerId: customer.id, customerName: customer.name, amount: '9007199254740993', status: 'succeeded', chainId: 5042002, txHash: `0x${'12'.repeat(32)}`, createdAt: customer.createdAt, ...overrides })

void test('customer confirmed collections use exact successful owned payments, never catalog estimates or pending debits', () => {
  const result = toCustomer(customer, [], [payment(), payment({ id: 'second', amount: '1' }), payment({ id: 'foreign', customerId: 'someone-else' }), payment({ id: 'pending', status: 'pending' })])
  assert.equal(result.lifetimeValue, '9007199254.740994')
})

void test('invoice display preserves the actual subscription identity for capability checkout actions', () => {
  const invoice: ApiInvoice = { id: 'invoice', number: 'INV-1', customerId: customer.id, customerName: customer.name, customerEmail: customer.email, subscriptionId: 'subscription', status: 'open', total: '100000000', amountPaid: '0', lineItems: [], memo: '', issuedAt: customer.createdAt, dueAt: customer.createdAt, createdAt: customer.createdAt }
  assert.equal(toInvoice(invoice, 'Merchant').subscriptionId, 'subscription')
  assert.equal(toInvoice({ ...invoice, subscriptionId: null }, 'Merchant').subscriptionId, null)
})

void test('live navigation never directs users to invented checkout or invoice fixtures', () => {
  for (const filename of ['Sidebar.tsx', 'PublicLayout.tsx']) {
    const source = readFileSync(new URL(`../src/components/layout/${filename}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\/pay\/demo|\/invoice\/inv_1042/)
  }
})
