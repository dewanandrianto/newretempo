/** JSON-only wire contract between the public API and the private verified-chain Worker. */
export type ChainAddress = `0x${string}`
export type ChainHash = `0x${string}`
export type ChainValue = string | boolean | null
export type ChainValues = Record<string, ChainValue>

export interface ChainConfiguration {
  chainId: 5042002
  mode: 'disabled' | 'local' | 'mainnet' | 'testnet'
  configured: boolean
  rpcUrl: string
  explorerUrl: string
  usdc: ChainAddress
  usdcDecimals: 6
  manager: ChainAddress | null
  escrow: ChainAddress | null
  startBlock: string | null
  genesisHash?: ChainHash
  managerCodeHash?: ChainHash
  escrowCodeHash?: ChainHash
  reason?: string
}

export type ChainBindingKind = 'plan' | 'subscription' | 'invoice' | 'payment' | 'escrow'
export interface ChainBinding {
  orgId: string
  kind: ChainBindingKind
  recordId: string
  key: ChainHash
  merchant: ChainAddress
  customer?: ChainAddress
  planKey?: ChainHash
  subscriptionKey?: ChainHash
  chargeNumber?: string
  amount?: string
  metadata?: ChainValues
}

export interface VerifiedChainEvent {
  id: string
  chainId: 5042002
  address: ChainAddress
  blockNumber: string
  blockHash: ChainHash
  transactionHash: ChainHash
  transactionIndex: number
  logIndex: number
  /** Canonical ISO-8601 time derived from the verified block timestamp. */
  timestamp: string
  name: string
  args: ChainValues
}

export interface ChainProjection {
  orgId: string
  kind: ChainBindingKind | 'mandate' | 'ledger' | 'dispute' | 'wallet'
  recordId: string
  key: ChainHash
  state: string
  values: ChainValues
  blockNumber: string
  transactionHash: ChainHash | null
}

export interface ChainCursor {
  blockNumber: string
  blockHash: ChainHash
  updatedAt: string
}

export interface ChainSnapshot {
  configuration: ChainConfiguration
  cursor: ChainCursor | null
  bindings: ChainBinding[]
  events: VerifiedChainEvent[]
  projections: ChainProjection[]
  /** When present this is ONE bounded page, never an all-time total. */
  pagination?: { snapshotId: string; nextToken: string | null; complete: boolean; after: number; through: number; highWater: number }
}

export interface ChainSyncResult {
  configuration: ChainConfiguration
  cursor: ChainCursor | null
  processedEvents: number
  duplicateEvents: number
  busy: boolean
}

/** The capability exposes checkout terms, not private customer contact information. */
export interface ChainCheckout {
  id: string
  status: 'open' | 'complete' | 'expired'
  expiresAt: string
  merchantName: string
  productName: string
  planName: string
  description: string
  amount: string
  interval: 'week' | 'month' | 'year'
  intervalSeconds: number
  trialDays: number
  escrowDays: number
  planKey: ChainHash
  merchant: ChainAddress
  payout: ChainAddress
  arbitrator: ChainAddress
  customerMayRefundUnvested: boolean
  subscriptionId: string
  invoiceId: string
  configuration: ChainConfiguration
  externalRef?: ChainHash
  subscriptionKey?: ChainHash
  customer?: ChainAddress
  paymentId?: string
  escrowId?: string | null
}

export interface ChainPlanPreparation {
  configuration: ChainConfiguration
  planId: string
  externalRef: ChainHash
  planKey: ChainHash
  merchant: ChainAddress
  payout: ChainAddress
  amount: string
  intervalSeconds: number
  trialSeconds: number
  graceSeconds: number
  vestDuration: number
  arbitrator: ChainAddress
  customerMayRefundUnvested: boolean
}
