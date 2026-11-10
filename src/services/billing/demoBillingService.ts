import * as demo from '@/data/demo'
import type { BillingService, Sourced } from './types'

const LATENCY_MS = 320

function respond<T>(data: T): Promise<Sourced<T>> {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ data, source: 'demo' }), LATENCY_MS)
  })
}

export const demoBillingService: BillingService = {
  getOverview: () => respond(demo.demoOverview),
  listProducts: () => respond(demo.demoProducts),
  listPlans: () => respond(demo.demoPlans),
  listCustomers: () => respond(demo.demoCustomers),
  listSubscriptions: () => respond(demo.demoSubscriptions),
  listInvoices: () => respond(demo.demoInvoices),
  getInvoice: (id) => respond(demo.demoInvoices.find((i) => i.id === id) ?? null),
  listPayments: () => respond(demo.demoPayments),
  getEscrow: () => respond(demo.demoEscrow),
  listTransactions: () => respond(demo.demoLedger),
  listDisputes: () => respond(demo.demoDisputes),
  getDeveloper: () => respond(demo.demoDeveloper),
  getCheckoutSession: (id) => respond(id === 'demo' ? demo.demoCheckout : null),
  getPortal: () => respond(demo.demoPortal),
}
