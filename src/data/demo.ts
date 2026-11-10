/**
 * DEMO DATA ONLY.
 * Everything here is fictional sample content used to preview the interface.
 * It is not read from a chain or a database and must never be presented as
 * verified onchain activity. There are intentionally no wallet addresses,
 * transaction hashes or contract addresses in this file.
 */
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

export const DEMO_MERCHANT = 'Northwind Labs'

export const demoProducts: Product[] = [
  { id: 'prod_atlas', name: 'Atlas Analytics', description: 'Product analytics for B2B SaaS teams.', status: 'active', planCount: 3, createdAt: '2026-01-12' },
  { id: 'prod_api', name: 'Atlas API', description: 'Programmatic access to events and reports.', status: 'active', planCount: 3, createdAt: '2026-03-02' },
  { id: 'prod_embed', name: 'Atlas Embedded', description: 'White-label dashboards inside your own app.', status: 'active', planCount: 1, createdAt: '2026-06-18' },
  { id: 'prod_legacy', name: 'Atlas Classic', description: 'Retired self-serve reporting tier.', status: 'archived', planCount: 1, createdAt: '2025-09-04' },
]

export const demoPlans: Plan[] = [
  { id: 'plan_starter', productId: 'prod_atlas', productName: 'Atlas Analytics', name: 'Starter', amount: '29.00', interval: 'month', trialDays: 14, subscribers: 142, escrowDays: 0, status: 'active' },
  { id: 'plan_growth', productId: 'prod_atlas', productName: 'Atlas Analytics', name: 'Growth', amount: '99.00', interval: 'month', trialDays: 14, subscribers: 61, escrowDays: 7, status: 'active' },
  { id: 'plan_scale', productId: 'prod_atlas', productName: 'Atlas Analytics', name: 'Scale', amount: '349.00', interval: 'month', trialDays: 0, subscribers: 18, escrowDays: 14, status: 'active' },
  { id: 'plan_dev', productId: 'prod_api', productName: 'Atlas API', name: 'Developer', amount: '19.00', interval: 'month', trialDays: 7, subscribers: 88, escrowDays: 0, status: 'active' },
  { id: 'plan_prod', productId: 'prod_api', productName: 'Atlas API', name: 'Production', amount: '249.00', interval: 'month', trialDays: 0, subscribers: 24, escrowDays: 7, status: 'active' },
  { id: 'plan_prod_y', productId: 'prod_api', productName: 'Atlas API', name: 'Production (annual)', amount: '2490.00', interval: 'year', trialDays: 0, subscribers: 9, escrowDays: 30, status: 'active' },
  { id: 'plan_embed', productId: 'prod_embed', productName: 'Atlas Embedded', name: 'Embed Pro', amount: '599.00', interval: 'month', trialDays: 0, subscribers: 6, escrowDays: 14, status: 'active' },
  { id: 'plan_classic', productId: 'prod_legacy', productName: 'Atlas Classic', name: 'Classic', amount: '15.00', interval: 'month', trialDays: 0, subscribers: 0, escrowDays: 0, status: 'archived' },
]

const names: [string, string, string][] = [
  ['Maya Okafor', 'Lumen Robotics', 'maya@lumenrobotics.example'],
  ['Daniel Reyes', 'Kestrel Health', 'daniel@kestrelhealth.example'],
  ['Priya Nair', 'Quillbase', 'priya@quillbase.example'],
  ['Tomas Berg', 'Fjord Freight', 'tomas@fjordfreight.example'],
  ['Aisha Rahman', 'Tidepool Games', 'aisha@tidepool.example'],
  ['Lucas Moreau', 'Verso Studio', 'lucas@versostudio.example'],
  ['Hana Sato', 'Orbit Ledger', 'hana@orbitledger.example'],
  ['Oliver Grant', 'Brightfield Edu', 'oliver@brightfield.example'],
  ['Sofia Marin', 'Canvasly', 'sofia@canvasly.example'],
  ['Jonas Weber', 'Helix Mobility', 'jonas@helixmobility.example'],
]

export const demoCustomers: Customer[] = names.map(([name, company, email], i) => ({
  id: `cus_${String(i + 1).padStart(3, '0')}`,
  name,
  email,
  company,
  createdAt: `2026-0${(i % 9) + 1}-${String(5 + i * 2).padStart(2, '0')}`,
  activeSubscriptions: i % 4 === 3 ? 2 : 1,
  lifetimeValue: ['4,188.00', '1,188.00', '2,094.00', '9,960.00', '348.00', '1,782.00', '5,988.00', '297.00', '1,044.00', '2,988.00'][i].replace(',', ''),
}))

const planFor = (id: string) => demoPlans.find((p) => p.id === id)!

const subSeed: [number, string, Subscription['status'], string][] = [
  [0, 'plan_scale', 'active', '2026-11-19'],
  [1, 'plan_growth', 'active', '2026-11-12'],
  [2, 'plan_starter', 'trialing', '2026-11-14'],
  [3, 'plan_prod_y', 'active', '2027-03-01'],
  [4, 'plan_dev', 'past_due', '2026-11-03'],
  [5, 'plan_growth', 'active', '2026-11-27'],
  [6, 'plan_embed', 'active', '2026-11-22'],
  [7, 'plan_starter', 'canceled', '2026-10-30'],
  [8, 'plan_prod', 'active', '2026-11-16'],
  [9, 'plan_growth', 'paused', '2026-12-02'],
]

export const demoSubscriptions: Subscription[] = subSeed.map(([c, p, status, end], i) => {
  const plan = planFor(p)
  const cust = demoCustomers[c]
  return {
    id: `sub_${String(i + 1).padStart(4, '0')}`,
    customerId: cust.id,
    customerName: cust.company,
    planName: plan.name,
    amount: plan.amount,
    interval: plan.interval,
    status,
    startedAt: cust.createdAt,
    currentPeriodEnd: end,
  }
})

const invSeed: [number, string, Invoice['status'], string, string][] = [
  [0, 'plan_scale', 'paid', '2026-10-19', '2026-11-02'],
  [1, 'plan_growth', 'paid', '2026-10-12', '2026-10-26'],
  [4, 'plan_dev', 'open', '2026-11-03', '2026-11-17'],
  [5, 'plan_growth', 'paid', '2026-10-27', '2026-11-10'],
  [6, 'plan_embed', 'open', '2026-11-05', '2026-11-19'],
  [8, 'plan_prod', 'paid', '2026-10-16', '2026-10-30'],
  [3, 'plan_prod_y', 'paid', '2026-03-01', '2026-03-15'],
  [9, 'plan_growth', 'draft', '2026-11-07', '2026-11-21'],
  [7, 'plan_starter', 'void', '2026-10-30', '2026-11-13'],
]

export const demoInvoices: Invoice[] = invSeed.map(([c, p, status, issued, due], i) => {
  const plan = planFor(p)
  const cust = demoCustomers[c]
  return {
    id: `inv_${String(1042 - i).padStart(4, '0')}`,
    number: `INV-2026-${String(1042 - i).padStart(4, '0')}`,
    customerName: cust.company,
    customerEmail: cust.email,
    merchantName: DEMO_MERCHANT,
    amount: plan.amount,
    status,
    issuedAt: issued,
    dueAt: due,
    lineItems: [{ description: `${plan.productName} - ${plan.name} (${plan.interval}ly)`, quantity: 1, unitAmount: plan.amount }],
  }
})

export const demoPayments: Payment[] = demoInvoices
  .filter((i) => i.status === 'paid' || i.status === 'open')
  .map((inv, i) => ({
    id: `pay_${String(i + 1).padStart(4, '0')}`,
    invoiceNumber: inv.number,
    customerName: inv.customerName,
    amount: inv.amount,
    status: inv.status === 'paid' ? ('succeeded' as const) : i % 2 ? ('pending' as const) : ('failed' as const),
    createdAt: inv.issuedAt,
  }))

export const demoEscrow: EscrowOverview = {
  contractState: 'not_deployed',
  held: '3294.00',
  pendingFunding: '0.00',
  releasable: '1047.00',
  disputed: '249.00',
  holds: [
    { id: 'esc_001', customerName: 'Lumen Robotics', reference: 'Scale', amount: '349.00', status: 'held', releaseAt: '2026-11-16' },
    { id: 'esc_002', customerName: 'Kestrel Health', reference: 'Growth', amount: '99.00', status: 'held', releaseAt: '2026-11-14' },
    { id: 'esc_003', customerName: 'Orbit Ledger', reference: 'Embed Pro', amount: '599.00', status: 'held', releaseAt: '2026-11-20' },
    { id: 'esc_004', customerName: 'Canvasly', reference: 'Production', amount: '249.00', status: 'disputed', releaseAt: '2026-11-12' },
    { id: 'esc_005', customerName: 'Verso Studio', reference: 'Growth', amount: '99.00', status: 'released', releaseAt: '2026-11-01' },
    { id: 'esc_006', customerName: 'Fjord Freight', reference: 'Production (annual)', amount: '2490.00', status: 'held', releaseAt: '2026-12-01' },
  ],
}

export const demoLedger: LedgerEntry[] = [
  { id: 'txn_0001', kind: 'payment', direction: 'in', amount: '349.00', counterparty: 'Lumen Robotics', status: 'succeeded', createdAt: '2026-11-06' },
  { id: 'txn_0002', kind: 'escrow_hold', direction: 'in', amount: '349.00', counterparty: 'Lumen Robotics', status: 'pending', createdAt: '2026-11-06' },
  { id: 'txn_0003', kind: 'payment', direction: 'in', amount: '99.00', counterparty: 'Verso Studio', status: 'succeeded', createdAt: '2026-11-05' },
  { id: 'txn_0004', kind: 'escrow_release', direction: 'in', amount: '99.00', counterparty: 'Verso Studio', status: 'succeeded', createdAt: '2026-11-05' },
  { id: 'txn_0005', kind: 'refund', direction: 'out', amount: '29.00', counterparty: 'Brightfield Edu', status: 'refunded', createdAt: '2026-11-03' },
  { id: 'txn_0006', kind: 'payout', direction: 'out', amount: '2400.00', counterparty: 'Settlement wallet', status: 'succeeded', createdAt: '2026-11-01' },
  { id: 'txn_0007', kind: 'payment', direction: 'in', amount: '19.00', counterparty: 'Tidepool Games', status: 'failed', createdAt: '2026-10-31' },
  { id: 'txn_0008', kind: 'payment', direction: 'in', amount: '249.00', counterparty: 'Canvasly', status: 'succeeded', createdAt: '2026-10-30' },
]

export const demoDisputes: Dispute[] = [
  { id: 'dsp_001', invoiceNumber: 'INV-2026-1037', customerName: 'Canvasly', amount: '249.00', reason: 'Service not as described', status: 'needs_response', openedAt: '2026-11-04', respondBy: '2026-11-11' },
  { id: 'dsp_002', invoiceNumber: 'INV-2026-1029', customerName: 'Brightfield Edu', amount: '29.00', reason: 'Duplicate charge', status: 'under_review', openedAt: '2026-10-28', respondBy: '2026-11-04' },
  { id: 'dsp_003', invoiceNumber: 'INV-2026-1011', customerName: 'Helix Mobility', amount: '99.00', reason: 'Cancelled before renewal', status: 'resolved', openedAt: '2026-10-09', respondBy: '2026-10-16' },
]

const months = ['Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov']
const revenue = [7200, 8400, 9100, 10800, 12200, 13900, 15100, 16800, 17600, 19400, 21300, 22750]

export const demoOverview: DashboardOverview = {
  totalRevenue: '164650.00',
  totalRevenueDelta: 12.4,
  mrr: '22750.00',
  mrrDelta: 6.8,
  activeSubscriptions: 348,
  activeSubscriptionsDelta: 4.2,
  pendingInvoices: 7,
  pendingInvoicesAmount: '1304.00',
  escrowBalance: '3294.00',
  revenueSeries: months.map((label, i) => ({ label, value: revenue[i] })),
  mrrSparkline: revenue,
  activity: months.slice(-8).map((label, i) => ({
    label,
    gained: [22, 26, 24, 31, 29, 35, 38, 41][i],
    lost: [6, 5, 8, 7, 6, 9, 7, 8][i],
  })),
  planMix: [
    { label: 'Starter', value: 142 },
    { label: 'Growth', value: 61 },
    { label: 'Scale', value: 18 },
    { label: 'API', value: 121 },
    { label: 'Embedded', value: 6 },
  ],
  recent: demoLedger.slice(0, 6),
}

export const demoCheckout: CheckoutSession = {
  id: 'demo',
  merchantName: DEMO_MERCHANT,
  planName: 'Growth',
  productName: 'Atlas Analytics',
  description: 'Unlimited dashboards, 5M events per month and priority support.',
  amount: '99.00',
  interval: 'month',
  trialDays: 14,
  escrowDays: 7,
}

export const demoPortal: PortalView = {
  customerName: 'Daniel Reyes',
  customerEmail: 'daniel@kestrelhealth.example',
  merchantName: DEMO_MERCHANT,
  subscriptions: demoSubscriptions.filter((s) => s.customerId === 'cus_002'),
  invoices: demoInvoices.filter((i) => i.customerEmail === 'daniel@kestrelhealth.example'),
}

export const demoDeveloper: DeveloperOverview = {
  apiKeys: [],
  webhooks: [],
}
