/**
 * Shared domain types. These are the contract between the frontend, the future
 * backend API and the PostgreSQL schema in /database. Keep them framework-free.
 */

/** USDC amount as a decimal string, e.g. "49.00". Never a float on a money path. */
export type UsdcAmount = string

export type BillingInterval = 'week' | 'month' | 'year'

export type SubscriptionStatus = 'incomplete' | 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled'
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible'
export type PaymentStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'refunded' | 'canceled'
export type EscrowStatus = 'pending_funding' | 'funded' | 'held' | 'released' | 'refunded' | 'settled' | 'disputed'
export type DisputeStatus = 'needs_response' | 'under_review' | 'resolved'
export type CatalogStatus = 'active' | 'archived'

export interface Product {
  id: string
  name: string
  description: string
  status: CatalogStatus
  planCount: number
  createdAt: string
}

export interface Plan {
  id: string
  productId: string
  productName: string
  name: string
  amount: UsdcAmount
  interval: BillingInterval
  trialDays: number
  subscribers: number
  escrowDays: number
  status: CatalogStatus
}

export interface Customer {
  id: string
  name: string
  email: string
  company: string
  createdAt: string
  activeSubscriptions: number
  lifetimeValue: UsdcAmount
}

export interface Subscription {
  id: string
  customerId: string
  customerName: string
  planName: string
  amount: UsdcAmount
  interval: BillingInterval
  status: SubscriptionStatus
  startedAt: string
  currentPeriodEnd: string
}

export interface InvoiceLineItem {
  description: string
  quantity: number
  unitAmount: UsdcAmount
}

export interface Invoice {
  id: string
  subscriptionId?: string | null
  number: string
  customerName: string
  customerEmail: string
  merchantName: string
  amount: UsdcAmount
  status: InvoiceStatus
  issuedAt: string
  dueAt: string
  lineItems: InvoiceLineItem[]
}

export interface Payment {
  id: string
  invoiceNumber: string
  customerName: string
  amount: UsdcAmount
  status: PaymentStatus
  createdAt: string
}

export interface EscrowHold {
  id: string
  customerName: string
  /** What the escrow is for: a plan name in demo data, an invoice number for live records. */
  reference: string
  amount: UsdcAmount
  status: EscrowStatus
  releaseAt: string | null
}

export interface EscrowOverview {
  /** Escrow contracts are not deployed in Phase 1. */
  contractState: 'not_deployed' | 'deployed'
  /** Funded and held by the contract. Always zero until verified chain events exist. */
  held: UsdcAmount
  /** Records created but not yet funded onchain. */
  pendingFunding: UsdcAmount
  releasable: UsdcAmount
  disputed: UsdcAmount
  holds: EscrowHold[]
}

export type LedgerKind = 'payment' | 'payout' | 'refund' | 'escrow_hold' | 'escrow_release'

export interface LedgerEntry {
  id: string
  kind: LedgerKind
  direction: 'in' | 'out'
  amount: UsdcAmount
  counterparty: string
  status: PaymentStatus
  createdAt: string
  transactionHash?: string
  chainId?: number
}

export interface Dispute {
  id: string
  invoiceNumber: string
  customerName: string
  amount: UsdcAmount
  reason: string
  status: DisputeStatus
  openedAt: string
  respondBy: string
}

export interface SeriesPoint {
  label: string
  /** Dimensionless chart coordinate. Never sum it to calculate money. */
  value: number
  /** Exact base units for live financial labels and totals. */
  baseUnits?: string
}

export interface DashboardOverview {
  totalRevenue: UsdcAmount
  totalRevenueDelta: number
  mrr: UsdcAmount
  mrrDelta: number
  activeSubscriptions: number
  activeSubscriptionsDelta: number
  pendingInvoices: number
  pendingInvoicesAmount: UsdcAmount
  escrowBalance: UsdcAmount
  revenueSeries: SeriesPoint[]
  mrrSparkline: number[]
  activity: { label: string; gained: number; lost: number }[]
  planMix: { label: string; value: number }[]
  recent: LedgerEntry[]
}

export interface CheckoutSession {
  id: string
  merchantName: string
  planName: string
  productName: string
  description: string
  amount: UsdcAmount
  interval: BillingInterval
  trialDays: number
  escrowDays: number
}

export interface PortalView {
  customerName: string
  customerEmail: string
  merchantName: string
  subscriptions: Subscription[]
  invoices: Invoice[]
}

export interface DeveloperOverview {
  apiKeys: { id: string; label: string; prefix: string; createdAt: string; revokedAt: string | null }[]
  webhooks: { id: string; url: string; events: string[]; status: 'active' | 'disabled' }[]
}
