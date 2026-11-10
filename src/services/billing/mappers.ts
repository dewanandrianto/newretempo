import { formatBaseUnits, sumBaseUnits } from '@shared/money'
import type {
  ApiCustomer,
  ApiEscrow,
  ApiInvoice,
  ApiPayment,
  ApiPlan,
  ApiProduct,
  ApiSubscription,
  Customer,
  EscrowOverview,
  Invoice,
  Payment,
  Plan,
  Product,
  Subscription,
} from '@shared/types'

/**
 * API records -> the display shapes the pages already render.
 * Amounts arrive as base-unit strings and are formatted with BigInt arithmetic only.
 */

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '')

export const toProduct = (p: ApiProduct): Product => ({
  id: p.id,
  name: p.name,
  description: p.description,
  status: p.status,
  planCount: p.planCount,
  createdAt: day(p.createdAt),
})

export const toPlan = (p: ApiPlan): Plan => ({
  id: p.id,
  productId: p.productId,
  productName: p.productName,
  name: p.name,
  amount: formatBaseUnits(p.amount),
  interval: p.interval,
  trialDays: p.trialDays,
  subscribers: p.subscriberCount,
  escrowDays: p.escrowDays,
  status: p.status,
})

export function toCustomer(c: ApiCustomer, subscriptions: ApiSubscription[], payments: ApiPayment[] = []): Customer {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    company: c.company || c.name,
    createdAt: day(c.createdAt),
    activeSubscriptions: subscriptions.filter((s) => s.customerId === c.id && s.status !== 'canceled').length,
    lifetimeValue: formatBaseUnits(payments.filter(p => p.customerId === c.id && p.status === 'succeeded').reduce((total, p) => total + BigInt(p.amount), 0n)),
  }
}

export const toSubscription = (s: ApiSubscription): Subscription => ({
  id: s.id,
  customerId: s.customerId,
  customerName: s.customerName,
  planName: s.planName,
  amount: formatBaseUnits(s.amount),
  interval: s.interval,
  status: s.status,
  startedAt: day(s.createdAt),
  currentPeriodEnd: s.currentPeriodEnd ?? '',
})

export const toInvoice = (i: ApiInvoice, merchantName: string): Invoice => ({
  id: i.id,
  subscriptionId: i.subscriptionId,
  number: i.number,
  customerName: i.customerName,
  customerEmail: i.customerEmail,
  merchantName,
  amount: formatBaseUnits(i.total),
  status: i.status,
  issuedAt: day(i.issuedAt ?? i.createdAt),
  dueAt: day(i.dueAt),
  lineItems: i.lineItems.map((l) => ({ description: l.description, quantity: l.quantity, unitAmount: formatBaseUnits(l.unitAmount) })),
})

export const toPayment = (p: ApiPayment): Payment => ({
  id: p.id,
  invoiceNumber: p.invoiceNumber,
  customerName: p.customerName,
  amount: formatBaseUnits(p.amount),
  status: p.status,
  createdAt: day(p.createdAt),
})

const sumWhere = (rows: ApiEscrow[], statuses: ApiEscrow['status'][]) =>
  formatBaseUnits(sumBaseUnits(rows.filter((r) => statuses.includes(r.status)).map((r) => BigInt(r.amount))))

export function toEscrowOverview(rows: ApiEscrow[]): EscrowOverview {
  return {
    contractState: 'not_deployed',
    held: sumWhere(rows, ['funded']),
    pendingFunding: sumWhere(rows, ['pending_funding']),
    releasable: '0.00', // nothing is releasable until verified chain events exist
    disputed: sumWhere(rows, ['disputed']),
    holds: rows.map((r) => ({
      id: r.id,
      customerName: r.customerName,
      reference: r.invoiceNumber,
      amount: formatBaseUnits(r.amount),
      status: r.status,
      releaseAt: r.releaseAt ? day(r.releaseAt) : null,
    })),
  }
}
