import type {
  ApiAuditLog,
  ApiCustomer,
  ApiEscrow,
  ApiInvoice,
  ApiKeyCreated,
  ApiKeyRecord,
  ApiMember,
  ApiOrganization,
  ApiPayment,
  ApiPlan,
  ApiProduct,
  ApiSubscription,
  ApiWallet,
  Interval,
} from '@shared/types'
import { requireActiveOrg } from '@/services/api/activeOrg'
import { del, get, patch, post } from '@/services/api/client'

/**
 * Typed merchant API. Every call is scoped to the active organization; the server independently
 * verifies membership and role on each request. Amounts are USDC base-unit strings.
 */
const base = () => `/orgs/${requireActiveOrg().id}`

/** Capture the tenant path once and exhaust the server's array-based offset pages. */
async function listAll<T>(path: string): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += 100) {
    const page = await get<T[]>(`${path}?limit=100&offset=${offset}`)
    if (!Array.isArray(page) || page.length > 100) throw new Error('Invalid paginated API response')
    rows.push(...page)
    if (page.length < 100) return rows
  }
}

export interface PlanInput {
  productId: string
  name: string
  amount: string
  interval: Interval
  trialDays: number
  escrowDays: number
}

export interface InvoiceInput {
  customerId: string
  subscriptionId?: string
  periodStart?: string
  lineItems: { description: string; quantity: number; unitAmount: string }[]
  dueAt: string
  memo?: string
}

export const merchant = {
  org: {
    get: () => get<ApiOrganization>(base()),
    update: (body: Partial<Pick<ApiOrganization, 'name' | 'website' | 'industry' | 'country'>>) => patch<ApiOrganization>(base(), body),
  },
  members: {
    list: () => get<ApiMember[]>(`${base()}/members`),
    add: (body: { email: string; role: 'admin' | 'member' }) => post<ApiMember>(`${base()}/members`, body),
    setRole: (userId: string, role: 'owner' | 'admin' | 'member') => patch<ApiMember>(`${base()}/members/${userId}`, { role }),
    remove: (userId: string) => del(`${base()}/members/${userId}`),
  },
  products: {
    list: () => listAll<ApiProduct>(`${base()}/products`),
    create: (body: { name: string; description: string }) => post<ApiProduct>(`${base()}/products`, body),
    update: (id: string, body: { status?: 'active' | 'archived'; name?: string; description?: string }) => patch<ApiProduct>(`${base()}/products/${id}`, body),
    remove: (id: string) => del(`${base()}/products/${id}`),
  },
  plans: {
    list: () => listAll<ApiPlan>(`${base()}/plans`),
    create: (body: PlanInput) => post<ApiPlan>(`${base()}/plans`, body),
    update: (id: string, body: { status?: 'active' | 'archived' }) => patch<ApiPlan>(`${base()}/plans/${id}`, body),
    remove: (id: string) => del(`${base()}/plans/${id}`),
  },
  customers: {
    list: () => listAll<ApiCustomer>(`${base()}/customers`),
    create: (body: { name: string; email: string; company: string }) => post<ApiCustomer>(`${base()}/customers`, body),
    update: (id: string, body: { status?: 'active' | 'archived' }) => patch<ApiCustomer>(`${base()}/customers/${id}`, body),
    remove: (id: string) => del(`${base()}/customers/${id}`),
  },
  subscriptions: {
    list: () => listAll<ApiSubscription>(`${base()}/subscriptions`),
    create: (body: { customerId: string; planId: string }) => post<ApiSubscription>(`${base()}/subscriptions`, body),
    cancel: (id: string) => patch<ApiSubscription>(`${base()}/subscriptions/${id}`, { status: 'canceled' }),
    remove: (id: string) => del(`${base()}/subscriptions/${id}`),
  },
  invoices: {
    list: () => listAll<ApiInvoice>(`${base()}/invoices`),
    create: (body: InvoiceInput, key: string) => post<ApiInvoice>(`${base()}/invoices`, body, key),
    finalize: (id: string) => post<ApiInvoice>(`${base()}/invoices/${id}/finalize`),
    void: (id: string) => post<ApiInvoice>(`${base()}/invoices/${id}/void`),
    remove: (id: string) => del(`${base()}/invoices/${id}`),
  },
  payments: {
    list: () => listAll<ApiPayment>(`${base()}/payments`),
    create: (invoiceId: string, key: string) => post<ApiPayment>(`${base()}/payments`, { invoiceId }, key),
    cancel: (id: string) => post<ApiPayment>(`${base()}/payments/${id}/cancel`),
  },
  escrows: {
    list: () => listAll<ApiEscrow>(`${base()}/escrows`),
    create: (body: { invoiceId: string; releaseAfterDays: number }, key: string) => post<ApiEscrow>(`${base()}/escrows`, body, key),
    remove: (id: string) => del(`${base()}/escrows/${id}`),
    history: (id: string) => get<ApiAuditLog[]>(`${base()}/escrows/${id}/history`),
  },
  wallets: {
    list: () => get<ApiWallet[]>(`${base()}/wallets`),
    create: (body: { purpose: 'payout' | 'customer'; address: string; label: string; customerId?: string }) => post<ApiWallet>(`${base()}/wallets`, body),
    remove: (id: string) => del(`${base()}/wallets/${id}`),
  },
  apiKeys: {
    list: () => get<ApiKeyRecord[]>(`${base()}/api-keys`),
    create: (body: { name: string; scopes: ('read' | 'write')[] }) => post<ApiKeyCreated>(`${base()}/api-keys`, body),
    revoke: (id: string) => del(`${base()}/api-keys/${id}`),
  },
}
