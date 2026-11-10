import { describe, expect, test } from 'bun:test'
import type { ApiEscrow, ApiInvoice, ApiPlan } from '@shared/types'
import { toEscrowOverview, toInvoice, toPlan } from '../../src/services/billing/mappers'

// Display mapping for the web app: base-unit strings in, decimal strings out, BigInt only.

describe('API to display mappers', () => {
  test('plan amounts format exactly', () => {
    const plan = { id: 'p', productId: 'x', productName: 'P', name: 'Pro', amount: '49000000', interval: 'month', trialDays: 0, escrowDays: 0, status: 'active', subscriberCount: 2, createdAt: '2026-11-07T00:00:00Z' } satisfies ApiPlan
    expect(toPlan(plan).amount).toBe('49.00')
    expect(toPlan({ ...plan, amount: '9007199254740993' }).amount).toBe('9007199254.740993')
  })

  test('invoice totals and line items', () => {
    const invoice = {
      id: 'i', number: 'INV-1', customerId: 'c', customerName: 'Acme', customerEmail: 'a@example.test', subscriptionId: null, status: 'open',
      total: '1500000', amountPaid: '0', memo: '', issuedAt: null, dueAt: '2026-12-01T00:00:00Z', createdAt: '2026-11-07T00:00:00Z',
      lineItems: [{ description: 'Seat', quantity: 3, unitAmount: '500000' }],
    } satisfies ApiInvoice
    const mapped = toInvoice(invoice, 'Org')
    expect(mapped.amount).toBe('1.50')
    expect(mapped.lineItems[0].unitAmount).toBe('0.50')
    expect(mapped.issuedAt).toBe('2026-11-07')
  })

  test('escrow overview sums by status with integers and never invents held funds', () => {
    const base = { invoiceId: 'i', invoiceNumber: 'INV-1', customerId: 'c', customerName: 'Acme', releaseAfterDays: 7, releaseAt: null, contractAddress: null, createdAt: '2026-11-07T00:00:00Z' }
    const rows: ApiEscrow[] = [
      { ...base, id: '1', amount: '10000001', status: 'pending_funding' },
      { ...base, id: '2', amount: '20000002', status: 'pending_funding' },
    ]
    const overview = toEscrowOverview(rows)
    expect(overview.pendingFunding).toBe('30.000003')
    expect(overview.held).toBe('0.00')
    expect(overview.releasable).toBe('0.00')
    expect(overview.contractState).toBe('not_deployed')
  })
})
