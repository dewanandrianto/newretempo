import type { ChainSnapshot } from '@shared/chain'
import { collectChainPages } from '../../../shared/chainPages'
import { requireActiveOrg } from '@/services/api/activeOrg'
import { get } from '@/services/api/client'
import { merchant } from '@/services/merchant/api'
import { buildLiveDisputes, buildLiveEscrow, buildLiveLedger, buildLiveOverview, type LiveBillingRecords } from './chainMappers'
import { toCustomer, toInvoice, toPayment, toPlan, toProduct, toSubscription } from './mappers'
import type { BillingService, Sourced } from './types'

const live = async <T>(fn: () => Promise<T>): Promise<Sourced<T>> => ({ data: await fn(), source: 'live' })
const snapshot = (orgId: string) => collectChainPages(token => get<ChainSnapshot>(`/orgs/${encodeURIComponent(orgId)}/chain/snapshot${token ? `?pageToken=${encodeURIComponent(token)}` : ''}`))
async function readModel(): Promise<{ state: ChainSnapshot; records: LiveBillingRecords }> {
  const orgId = requireActiveOrg().id
  const [state, plans, subscriptions, invoices, escrows] = await Promise.all([
    snapshot(orgId), merchant.plans.list(), merchant.subscriptions.list(), merchant.invoices.list(), merchant.escrows.list(),
  ])
  if (requireActiveOrg().id !== orgId) throw new Error('Organization changed while loading billing records. Please retry.')
  return { state, records: { orgId, plans, subscriptions, invoices, escrows } }
}

/** Authenticated live reads only. Unsupported legacy public reads must never return sample records. */
export const liveBillingService: BillingService = {
  getOverview: () => live(async () => { const { state, records } = await readModel(); return buildLiveOverview(state, records) }),
  listProducts: () => live(async () => (await merchant.products.list()).map(toProduct)),
  listPlans: () => live(async () => (await merchant.plans.list()).map(toPlan)),
  listCustomers: () => live(async () => {
    const [customers, subscriptions, payments] = await Promise.all([merchant.customers.list(), merchant.subscriptions.list(), merchant.payments.list()])
    return customers.map(c => toCustomer(c, subscriptions, payments))
  }),
  listSubscriptions: () => live(async () => (await merchant.subscriptions.list()).map(toSubscription)),
  listInvoices: () => live(async () => {
    const name = requireActiveOrg().name
    return (await merchant.invoices.list()).map(i => toInvoice(i, name))
  }),
  listPayments: () => live(async () => (await merchant.payments.list()).map(toPayment)),
  getEscrow: () => live(async () => { const { state, records } = await readModel(); return buildLiveEscrow(state, records) }),
  listTransactions: () => live(async () => {
    const orgId = requireActiveOrg().id
    return buildLiveLedger(await snapshot(orgId), orgId)
  }),
  listDisputes: () => live(async () => { const { state, records } = await readModel(); return buildLiveDisputes(state, records) }),
  getInvoice: () => live(() => Promise.resolve(null)),
  getCheckoutSession: () => live(() => Promise.resolve(null)),
  getPortal: () => live(() => Promise.reject(new Error('Use the authenticated wallet portal for verified customer records.'))),
  getDeveloper: () => live(async () => ({
    apiKeys: (await merchant.apiKeys.list()).map(k => ({ id: k.id, label: k.name, prefix: k.prefix, createdAt: k.createdAt, revokedAt: k.revokedAt })),
    webhooks: [],
  })),
}
