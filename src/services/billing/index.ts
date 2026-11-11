import { liveBillingService } from './liveBillingService'
import type { BillingService } from './types'

/**
 * Single injection point for billing data. Merchant records come from the live backend;
 * analytics, ledger entries, and disputes are derived from verified chain data.
 */
export const billing: BillingService = liveBillingService

export type { BillingService, DataSource, Sourced } from './types'
