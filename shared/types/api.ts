/**
 * Wire types for the RETEMPO HTTP API (camelCase JSON).
 * All money fields are USDC base-unit integer strings (6 decimals), e.g. "49000000" = 49 USDC.
 * They are strings so they survive JSON without precision loss; convert with @shared/money.
 */

export type UsdcBaseUnits = string
export type OrgRole = 'owner' | 'admin' | 'member'
export type Interval = 'week' | 'month' | 'year'

export interface ApiOrganization {
  id: string
  name: string
  slug: string
  website: string | null
  industry: string
  country: string
  createdAt: string
}

export interface ApiMember {
  userId: string
  email: string | null
  displayName: string
  role: OrgRole
  createdAt: string
}

export interface ApiProduct {
  id: string
  name: string
  description: string
  status: 'active' | 'archived'
  planCount: number
  createdAt: string
  updatedAt: string
}

export interface ApiPlan {
  id: string
  productId: string
  productName: string
  name: string
  amount: UsdcBaseUnits
  interval: Interval
  trialDays: number
  escrowDays: number
  status: 'active' | 'archived'
  subscriberCount: number
  createdAt: string
}

export interface ApiCustomer {
  id: string
  name: string
  email: string
  company: string
  status: 'active' | 'archived'
  createdAt: string
}

export type ApiSubscriptionStatus = 'incomplete' | 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled'

export interface ApiSubscription {
  id: string
  customerId: string
  customerName: string
  planId: string
  planName: string
  status: ApiSubscriptionStatus
  amount: UsdcBaseUnits
  interval: Interval
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  createdAt: string
}

export interface ApiLineItem {
  description: string
  quantity: number
  unitAmount: UsdcBaseUnits
}

export type ApiInvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible'

export interface ApiInvoice {
  id: string
  number: string
  customerId: string
  customerName: string
  customerEmail: string
  subscriptionId: string | null
  status: ApiInvoiceStatus
  total: UsdcBaseUnits
  amountPaid: UsdcBaseUnits
  lineItems: ApiLineItem[]
  memo: string
  issuedAt: string | null
  dueAt: string
  createdAt: string
}

export type ApiPaymentStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'canceled'

export interface ApiPayment {
  id: string
  invoiceId: string
  invoiceNumber: string
  customerId: string
  customerName: string
  amount: UsdcBaseUnits
  status: ApiPaymentStatus
  chainId: number
  txHash: string | null
  createdAt: string
}

export type ApiEscrowStatus = 'pending_funding' | 'funded' | 'released' | 'refunded' | 'settled' | 'disputed'

export interface ApiEscrow {
  id: string
  invoiceId: string
  invoiceNumber: string
  customerId: string
  customerName: string
  amount: UsdcBaseUnits
  status: ApiEscrowStatus
  releaseAfterDays: number
  releaseAt: string | null
  contractAddress: string | null
  createdAt: string
}

export interface ApiWallet {
  id: string
  purpose: 'payout' | 'customer'
  address: string
  chainId: number
  label: string
  customerId: string | null
  /** True only when ownership was proven with a signature. Merchant-declared addresses are unverified. */
  verified: boolean
  createdAt: string
}

export interface ApiKeyRecord {
  id: string
  name: string
  prefix: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

export interface ApiKeyCreated extends ApiKeyRecord {
  /** Shown exactly once. Only a keyed hash is stored. */
  secret: string
}

export interface ApiAuditLog {
  id: string
  action: string
  resourceType: string
  resourceId: string | null
  actorUserId: string | null
  actorType: 'user' | 'system' | 'api_key' | 'chain'
  metadata: Record<string, unknown>
  createdAt: string
}

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string>; requestId?: string }
}
