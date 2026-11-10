import type {
  CheckoutSession,
  Customer,
  DashboardOverview,
  DeveloperOverview,
  Dispute,
  EscrowOverview,
  Invoice,
  LedgerEntry,
  Payment,
  Plan,
  PortalView,
  Product,
  Subscription,
} from '@shared/types'

/** Where a response came from. UI must label anything that is not 'live'. */
export type DataSource = 'demo' | 'live'

export interface Sourced<T> {
  data: T
  source: DataSource
}

/**
 * Billing read model. Phase 1 ships a demo implementation; Phase 2 adds an
 * HTTP implementation backed by PostgreSQL behind the same interface.
 */
export interface BillingService {
  getOverview(): Promise<Sourced<DashboardOverview>>
  listProducts(): Promise<Sourced<Product[]>>
  listPlans(): Promise<Sourced<Plan[]>>
  listCustomers(): Promise<Sourced<Customer[]>>
  listSubscriptions(): Promise<Sourced<Subscription[]>>
  listInvoices(): Promise<Sourced<Invoice[]>>
  getInvoice(id: string): Promise<Sourced<Invoice | null>>
  listPayments(): Promise<Sourced<Payment[]>>
  getEscrow(): Promise<Sourced<EscrowOverview>>
  listTransactions(): Promise<Sourced<LedgerEntry[]>>
  listDisputes(): Promise<Sourced<Dispute[]>>
  getDeveloper(): Promise<Sourced<DeveloperOverview>>
  getCheckoutSession(id: string): Promise<Sourced<CheckoutSession | null>>
  getPortal(): Promise<Sourced<PortalView>>
}
