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

/** Live-only data provenance; no demo provider is supported. */
export type DataSource = 'live'

export interface Sourced<T> {
  data: T
  source: DataSource
}

/**
 * Billing read model backed by live account records and verified chain data.
 * When records do not exist, callers should render an empty state.
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
