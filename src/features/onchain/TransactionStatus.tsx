import { Button } from '@/components/ui/Button'
import type { TransactionState, TransactionPhase } from '@/services/blockchain/transactions'
const labels:Record<TransactionPhase,string>={idle:'Ready for your review',checking:'Checking payment details and wallet readiness', 'wallet-prompt':'Confirm the transaction in your wallet','approval-prompt':'Approve the exact USDC allowance in your wallet','approval-pending':'USDC approval submitted; waiting for its receipt','approval-confirmed':'Approval confirmed. Continue the reviewed action.', 'pending-receipt':'Transaction submitted; waiting for its receipt',rejected:'Wallet request rejected',reverted:'Transaction reverted',error:'Action could not proceed','submission-unknown':'Submission outcome unknown — do not pay again','confirmed-indexing-pending':'Confirmed onchain — backend verification pending','verified-success':'Verified by the backend'}
export function TransactionStatus({state,error,busy=false,onSync,onResume}:{state:TransactionState;error?:string;busy?:boolean;onSync?:()=>void;onResume?:()=>void}) {
 return <div className="space-y-3 rounded-xl border border-line bg-midnight/60 p-4" role="status" aria-live="polite">
  <p className={`text-sm font-medium ${state.phase==='verified-success'?'text-positive':'text-fg'}`}>{labels[state.phase]}</p>
  {(state.error||error)&&<p className="text-sm text-caution">{error??state.error}</p>}
  {state.approvalHash&&<p className="text-xs text-dim">Approval transaction <span className="mono block break-all text-faint">{state.approvalHash}</span></p>}
  {state.hash&&<p className="text-xs text-dim">Transaction <span className="mono block break-all text-faint">{state.hash}</span></p>}
  {['pending-receipt','approval-pending'].includes(state.phase)&&onResume&&<Button variant="secondary" size="sm" loading={busy} onClick={onResume}>Check receipt</Button>}
  {state.phase==='confirmed-indexing-pending'&&onSync&&<Button variant="secondary" size="sm" loading={busy} onClick={onSync}>Retry verification</Button>}
  {state.phase==='submission-unknown'&&<p className="text-xs text-dim">Inspect the original wallet activity and contact the merchant. Retempo will not automatically resubmit an uncertain payment.</p>}
 </div>
}
export const canSubmit=(phase:TransactionPhase)=>['idle','error','rejected','approval-confirmed'].includes(phase)
