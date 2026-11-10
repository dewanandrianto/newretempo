import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ChainBinding, ChainCheckout, ChainSnapshot } from '../../../shared/chain'
import { useRetempoTransactions } from '@/features/onchain/useRetempoTransactions'
import { ContractAction } from '@/features/onchain/ContractAction'
import { displayUsdc, parseUsdc } from '@/services/blockchain'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
const inputClass='mt-2 w-full min-w-0 rounded-lg border border-line bg-midnight p-3 text-sm text-fg focus:border-cyan focus:outline-none'
export function SubscriptionCard({binding:b,snapshot}:{binding:ChainBinding;snapshot:ChainSnapshot}) {
 const c=snapshot.configuration
 const tx=useRetempoTransactions(c,`subscription-read:${b.key}`)
 const data=useQuery({queryKey:['customer-chain','subscription-view',b.key,c.genesisHash,snapshot.cursor?.blockHash],queryFn:async()=>{
  const sdk=tx.client(),s=await sdk.getSubscription(b.key)
  if(s.status===0)return null
  const [p,m,w,accepted]=await Promise.all([sdk.getPlan(s.planKey),sdk.getMandate(b.key),sdk.windows(),sdk.acceptedEscrowTerms(b.key)])
  return {s,p,m,w,accepted}
 },retry:false})
 const [accepted,setAccepted]=useState(false),[renewAccepted,setRenewAccepted]=useState(false),[cancel,setCancel]=useState(false)
 const [total,setTotal]=useState(''),[expiry,setExpiry]=useState(''),[authorize,setAuthorize]=useState(false)
 if(data.isPending)return <Card className="p-5 text-sm text-dim">Reading the subscription and its exact onchain terms…</Card>
 if(data.isError)return <Card className="space-y-3 p-5"><p role="alert" className="text-sm text-caution">{data.error.message}</p><Button onClick={()=>void data.refetch()}>Retry subscription</Button></Card>
 if(!data.data)return <Card className="p-5 text-sm text-dim">Subscription prepared, but not yet created onchain. Use the merchant's checkout link to subscribe.</Card>
 const {s,p,m,w,accepted:terms}=data.data
 const stale=p.vestDuration>0&&(terms[0]!==w.responseWindow||terms[1]!==w.resolutionTimeout)
 const context:ChainCheckout={id:b.recordId,status:'open',expiresAt:'9999-01-01T00:00:00Z',merchantName:'',productName:'',planName:'',description:'',amount:s.amount.toString(),interval:'month',intervalSeconds:p.interval,trialDays:p.trial/86400,escrowDays:p.vestDuration/86400,planKey:s.planKey,merchant:p.merchant as `0x${string}`,payout:p.payout as `0x${string}`,arbitrator:p.arbitrator as `0x${string}`,customerMayRefundUnvested:p.customerMayRefundUnvested,subscriptionId:b.recordId,invoiceId:'',configuration:c}
 const payment=snapshot.bindings.find(v=>v.kind==='payment'&&v.subscriptionKey===b.key&&v.chargeNumber===(BigInt(s.chargeCount)+1n).toString())
 const base={configuration:c},active=s.status===1
 const budgetValid=(()=>{try{return parseUsdc(total)>=s.amount&&Number.isFinite(Date.parse(expiry))}catch{return false}})()
 return <Card className="min-w-0 space-y-5 p-5 sm:p-6">
  <div className="flex flex-wrap justify-between gap-3"><h3 className="font-semibold text-fg">Subscription <span className="mono text-sm text-dim">{b.recordId}</span></h3><span className="text-sm text-cyan">{active?'Active':'Canceled'}</span></div>
  <p className="num text-lg text-fg">{displayUsdc(s.amount)} USDC <span className="text-sm text-dim">every {s.interval.toLocaleString()} seconds</span></p>
  <p className="text-sm text-dim">Next charge eligible: {new Date(s.nextChargeAt*1000).toLocaleString()}. {s.chargeCount.toLocaleString()} payment(s) recorded onchain.</p>
  <details className="text-xs text-dim"><summary className="cursor-pointer py-2">Review current recipient and escrow terms</summary><dl className="space-y-3 break-all py-3"><dt>Payout</dt><dd className="mono">{p.payout}</dd><dt>Arbitrator</dt><dd className="mono">{p.arbitrator}</dd><dt>Linear vesting</dt><dd>{p.vestDuration.toLocaleString()} seconds</dd><dt>Unvested customer refunds</dt><dd>{p.customerMayRefundUnvested?'Permitted':'Not permitted'}</dd><dt>Response / resolution from dispute opening</dt><dd>{w.responseWindow.toLocaleString()} / {w.resolutionTimeout.toLocaleString()} seconds</dd></dl></details>
  {stale&&<div className="space-y-4 rounded-xl border border-caution/30 p-4"><p className="text-sm text-caution">Escrow dispute windows changed. Renewal requires your explicit consent. Accepting changed terms revokes any existing recurring mandate; it never silently recreates one.</p><label className="flex items-start gap-3 text-sm text-dim"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)} className="mt-1 size-4" /><span>I accept a response window of {w.responseWindow.toLocaleString()} seconds and a resolution timeout of {w.resolutionTimeout.toLocaleString()} seconds from dispute opening. Arbitration ends exclusively at that deadline.</span></label><ContractAction {...base} operationKey={`consent:${b.key}:${w.responseWindow}:${w.resolutionTimeout}`} label="Accept these exact escrow windows" disabled={!active||!accepted} action={(sdk,write)=>sdk.acceptEscrowTerms(b.key,w,write)} target={{kind:'subscription',key:b.key,states:['active'],eventNames:['EscrowTermsAccepted']}} /></div>}
  <label className="flex items-start gap-3 text-sm text-dim"><input type="checkbox" checked={renewAccepted&&!stale} onChange={e=>setRenewAccepted(e.target.checked)} disabled={stale} className="mt-1 size-4" /><span>For manual renewal, I approve exactly {displayUsdc(s.amount)} USDC and the recipient, vesting, arbitrator and windows shown above. Gas is additional.</span></label>
  <ContractAction {...base} operationKey={`renew:${b.key}:${s.chargeCount}`} label="Approve exact amount & renew" disabled={!active||stale||!renewAccepted||!payment} action={(sdk,write)=>sdk.renew(b.key,context,w,write)} target={{kind:'payment',recordId:payment?.recordId??'missing-invoice',states:['paid','succeeded'],eventNames:['SubscriptionPaymentProcessed']}} />
  {!payment&&active&&<p className="text-xs text-dim">The merchant must prepare the next invoice and capability before another charge can be reconciled. Renewal is disabled until that stable payment identity exists.</p>}
  <div className="space-y-4 border-t border-line pt-5"><h4 className="text-sm font-medium text-fg">Finite recurring authorization</h4><p className="text-sm text-dim">{m.active?`Active budget: ${displayUsdc(m.totalCap)} USDC; ${displayUsdc(m.spent)} spent. Expires ${new Date(m.expiry*1000).toLocaleString()}.`:'No active mandate. Manual renewal is independent of recurring authorization.'}</p>
   {m.active&&<ContractAction {...base} operationKey={`revoke:${b.key}:${m.nonce}`} label="Revoke recurring mandate" action={(sdk,write)=>sdk.revokeMandate(b.key,write)} target={{kind:'mandate',key:b.key,states:['revoked'],eventNames:['MandateRevoked']}} />}
   <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><label className="text-xs text-dim">New total budget (USDC)<input className={inputClass} value={total} inputMode="decimal" placeholder="Enter a finite total" onChange={e=>{setTotal(e.target.value);setAuthorize(false)}} /></label><label className="text-xs text-dim">Exclusive expiry (your local time)<input type="datetime-local" className={inputClass} value={expiry} onChange={e=>{setExpiry(e.target.value);setAuthorize(false)}} /></label></div>
   <p className="text-xs text-dim">Per-charge cap: {displayUsdc(s.amount)} USDC. The token allowance is shared across all your subscriptions to this manager; replacing it can affect other mandates. Total budget must be at least the per-charge cap. Maximum duration: 366 days. A budget does not guarantee payment execution or bypass issuer blocklisting.</p>
   <label className="flex items-start gap-3 text-sm text-dim"><input type="checkbox" className="mt-1 size-4" checked={authorize} onChange={e=>setAuthorize(e.target.checked)} /><span>I explicitly authorize this new finite budget and expiry, including replacing any existing mandate. This also replaces the manager's token allowance with this exact budget.</span></label>
   <ContractAction {...base} operationKey={`mandate:${b.key}:${m.nonce}`} label="Approve finite budget & create mandate" disabled={!active||stale||!budgetValid||!authorize} action={(sdk,write)=>sdk.createMandate(b.key,{perChargeCap:s.amount.toString(),totalCap:parseUsdc(total).toString(),expiry:Math.floor(Date.parse(expiry)/1000)},context,w,write)} target={{kind:'mandate',key:b.key,states:['active'],eventNames:['MandateCreated']}} />
  </div>
  {active&&<div className="space-y-4 border-t border-line pt-5"><label className="flex items-start gap-3 text-sm text-dim"><input type="checkbox" checked={cancel} onChange={e=>setCancel(e.target.checked)} className="mt-1 size-4" /><span>Cancel future subscription payments and revoke its mandate. This does not refund already-paid periods or revoke the token allowance used by other mandates.</span></label><ContractAction {...base} operationKey={`cancel:${b.key}`} label="Cancel subscription" variant="danger" disabled={!cancel} action={(sdk,write)=>sdk.cancelSubscription(b.key,write)} target={{kind:'subscription',key:b.key,states:['canceled'],eventNames:['SubscriptionCanceled']}} /></div>}
 </Card>
}
