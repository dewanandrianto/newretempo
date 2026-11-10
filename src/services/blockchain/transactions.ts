import type { Hash } from 'viem'
import type { ChainProjection } from '../../../shared/chain'
export interface VerificationTarget {kind:ChainProjection['kind'];key?:Hash;recordId?:string;states:readonly string[];eventNames:readonly string[]}
export type RememberVerification = (target:VerificationTarget)=>void
export type TransactionPhase = 'idle' | 'checking' | 'wallet-prompt' | 'approval-prompt' | 'approval-pending' | 'approval-confirmed' | 'pending-receipt' | 'rejected' | 'reverted' | 'error' | 'submission-unknown' | 'confirmed-indexing-pending' | 'verified-success'
export interface TransactionState { id: string; phase: TransactionPhase; hash?: Hash; approvalHash?: Hash; error?: string; verification?:VerificationTarget }
export interface JournalStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export type ReceiptStatus = 'success' | 'reverted'
export type WriteTransaction = (kind: 'approval' | 'payment', send: () => Promise<Hash>, receipt: (hash: Hash) => Promise<ReceiptStatus>) => Promise<void>
const active = new Set<string>()
const protectedPhases: TransactionPhase[] = ['wallet-prompt', 'approval-prompt', 'approval-pending', 'pending-receipt', 'submission-unknown', 'confirmed-indexing-pending', 'verified-success', 'reverted']
export function isWalletRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('code' in error && error.code === 4001) return true
  if ('name' in error && error.name === 'UserRejectedRequestError') return true
  return 'cause' in error && isWalletRejection(error.cause)
}
export class TransactionRunner {
  constructor(private readonly storage: JournalStorage, private readonly onState: (state: TransactionState) => void = () => {}) {}
  load(id: string): TransactionState | null {
    const raw = this.storage.getItem(`retempo.tx.v1.${id}`)
    if (!raw) return null
    const state: unknown = JSON.parse(raw)
    if (!state || typeof state !== 'object' || !('id' in state) || state.id !== id || !('phase' in state) || typeof state.phase !== 'string') throw new Error('Transaction recovery data is invalid. Do not resubmit; inspect your wallet activity.')
    return state as TransactionState
  }
  private save(state: TransactionState): void {
    // Persist before notifying UI or opening the next prompt. Storage failure must stop writes.
    this.storage.setItem(`retempo.tx.v1.${state.id}`, JSON.stringify(state))
    this.onState(state)
  }
  async run(id: string, task: (write: WriteTransaction, remember:RememberVerification) => Promise<void>): Promise<void> {
    const operation = async () => {
      if (active.has(id)) return
      const previous = this.load(id)
      if (previous && protectedPhases.includes(previous.phase)) { this.onState(previous); return }
      active.add(id)
      let current: TransactionState = {id, phase:'checking', approvalHash: previous?.approvalHash}
      const update = (next: Partial<TransactionState>) => { current = {...current, ...next}; this.save(current) }
      try {
        update({phase:'checking', error:undefined})
        await task(async (kind, send, receipt) => {
          const approval = kind === 'approval'
          update({phase:approval ? 'approval-prompt' : 'wallet-prompt', error:undefined})
          let hash: Hash
          try { hash = await send() } catch (error) {
            update({phase:isWalletRejection(error) ? 'rejected' : 'submission-unknown', error:isWalletRejection(error) ? 'Wallet request rejected. No transaction was authorized.' : 'Submission outcome is unknown. Check wallet activity; do not submit again.'})
            throw error
          }
          update(approval ? {phase:'approval-pending', approvalHash:hash} : {phase:'pending-receipt', hash})
          const status = await receipt(hash)
          if (status !== 'success') { update({phase:'reverted', error:'Transaction reverted onchain. No success was recorded.'}); throw new Error('Transaction reverted.') }
          update({phase:approval ? 'approval-confirmed' : 'confirmed-indexing-pending'})
        },verification=>update({verification}))
      } catch (error) {
        if (['checking','approval-confirmed'].includes(current.phase)) update({phase:'error', error:error instanceof Error ? error.message : 'Transaction check failed.'})
        else if (['pending-receipt','approval-pending'].includes(current.phase)) update({error:'Receipt not yet available. Resume receipt checking without resubmitting.'})
      } finally { active.delete(id) }
    }
    if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(`retempo.tx.${id}`, operation)
    else await operation()
  }
  async resume(id: string, receipt: (hash: Hash) => Promise<ReceiptStatus>): Promise<void> {
    const s = this.load(id)
    if (!s || !['pending-receipt', 'approval-pending'].includes(s.phase)) return
    const approval = s.phase === 'approval-pending'
    const hash = approval ? s.approvalHash : s.hash
    if (!hash) throw new Error('Receipt hash is missing. Do not resubmit.')
    const status = await receipt(hash)
    this.save({...s, phase:status === 'reverted' ? 'reverted' : approval ? 'approval-confirmed' : 'confirmed-indexing-pending', error:undefined})
  }
  async verify(id: string, proof: (hash: Hash) => Promise<boolean>): Promise<void> {
    const s = this.load(id)
    if (s?.phase !== 'confirmed-indexing-pending' || !s.hash) return
    try {
      const verified = await proof(s.hash)
      this.save({...s, phase:verified ? 'verified-success' : 'confirmed-indexing-pending', error:verified ? undefined : 'Confirmed onchain; waiting for the verified backend projection.'})
    } catch (error) {
      this.save({...s, error:error instanceof Error ? error.message : 'Indexing is temporarily unavailable. Retry sync, not payment.'})
    }
  }
}
