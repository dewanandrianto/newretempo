import { liveBillingService } from './liveBillingService'
import type { BillingService } from './types'

/**
 * Single injection point for billing data. Merchant records are read from the backend;
 * analytics, the ledger and disputes remain labeled demo data until chain data is indexed.
 */
export const billing: BillingService = liveBillingService

export type { BillingService, DataSource, Sourced } from './types'
