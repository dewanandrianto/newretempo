import { withTx, type Db } from '../db/client'

/**
 * PHASE 3 SEAM. Not used by any HTTP route.
 *
 * Authoritative financial state (payment succeeded, escrow funded / released / refunded /
 * settled, invoice paid, ledger transactions) may only change in response to a VERIFIED
 * blockchain event. The database refuses those changes unless the surrounding transaction
 * switches on `retempo.authoritative`; `runAuthoritative` is the only sanctioned way to do so.
 *
 * Phase 3 will build an indexer that verifies logs from the deployed contracts (chain id,
 * contract address, confirmations, log index dedupe) and only then call into this seam.
 * Phase 2 deliberately ships no event processor and no simulated settlement.
 */
export interface VerifiedChainEvent {
  chainId: number
  txHash: `0x${string}`
  logIndex: number
  blockNumber: bigint
  contractAddress: `0x${string}`
}

export async function runAuthoritative<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return withTx(db, async (tx) => {
    await tx`SELECT set_config('retempo.authoritative', 'on', true)`
    return fn(tx)
  })
}
