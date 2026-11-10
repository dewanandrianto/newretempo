import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { isAddress, zeroAddress } from 'viem'
import type { Plan } from '@shared/types'
import type { ChainPlanPreparation } from '../../../shared/chain'
import { useAuth } from '@/features/auth/AuthProvider'
import { useCan } from '@/features/auth/permissions'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { WalletButton } from '@/components/wallet/WalletButton'
import { chainApi, displayUsdc } from '@/services/blockchain'
import { ContractAction } from './ContractAction'
import { useRetempoTransactions } from './useRetempoTransactions'
import { assertPreparedMerchant } from './merchantModel'

export const merchantInput='w-full min-w-0 rounded-lg border border-line bg-midnight p-3 text-sm text-fg'
export function useMerchantChain() {
 const {session}=useAuth(),orgId=session?.organization?.id
 const configuration=useQuery({queryKey:['merchant-chain','configuration',orgId],queryFn:chainApi.configuration,enabled:Boolean(orgId),retry:false})
 const snapshot=useQuery({queryKey:['merchant-chain','snapshot',orgId],queryFn:()=>chainApi.organizationSnapshot(orgId!),enabled:Boolean(orgId&&configuration.data?.configured),retry:false,refetchInterval:15000})
 return {orgId,configuration,snapshot,loadSnapshot:()=>chainApi.organizationSnapshot(orgId!)}
}
function PublishPlanForm({plan}:{plan:Plan}) {
 const chain=useMerchantChain(),{address}=useAccount(),c=chain.configuration.data
 const tx=useRetempoTransactions(c,`publish:${plan.id}`,chain.loadSnapshot)
 const [payout,setPayout]=useState(address??''),[arbitrator,setArbitrator]=useState(''),[refund,setRefund]=useState(false)
 const [prepared,setPrepared]=useState<ChainPlanPreparation>(),[error,setError]=useState<string>(),[busy,setBusy]=useState(false),[consent,setConsent]=useState(false)
 const published=chain.snapshot.data?.projections.some(p=>p.kind==='plan'&&p.recordId===plan.id&&p.state==='active')
 const prepare=async()=>{
  if(!chain.orgId||!address||!c||!tx.verifiedWallet)return
  setBusy(true);setError(undefined)
  try {
   await tx.client().assertWallet()
   const p=await chainApi.preparePlan(chain.orgId,plan.id,{wallet:address,payout:payout as `0x${string}`,arbitrator:plan.escrowDays?arbitrator as `0x${string}`:zeroAddress,customerMayRefundUnvested:plan.escrowDays>0&&refund})
   assertPreparedMerchant(p,c,address,plan.id);setPrepared(p);setConsent(false)
  }catch(e){setError(e instanceof Error?e.message:'Preparation failed.')}finally{setBusy(false)}
 }
 if(chain.configuration.isPending)return <p role="status">Loading verified deployment…</p>
 if(!c?.configured)return <p role="alert" className="text-sm text-caution">{chain.configuration.error?.message??c?.reason??'Onchain publishing is disabled.'}</p>
 return <div className="space-y-4" data-testid={`publish-plan-${plan.id}`}>
  <WalletButton compact />
  <p className="text-xs text-dim">{c.mode==='local'?'Local Arc simulation — not mainnet funds.':'Arc mainnet · chain 5042'}</p>
  {published?<p role="status" className="text-sm text-cyan">This plan is published in the verified backend.</p>:<>
   {!prepared?<>
    <label className="block space-y-2 text-sm text-dim"><span>Payout address</span><input className={merchantInput} value={payout} onChange={e=>setPayout(e.target.value)} /></label>
    {plan.escrowDays>0&&<><label className="block space-y-2 text-sm text-dim"><span>Arbitrator address</span><input className={merchantInput} value={arbitrator} onChange={e=>setArbitrator(e.target.value)} /></label><label className="flex gap-3 text-sm text-dim"><input type="checkbox" checked={refund} onChange={e=>setRefund(e.target.checked)} />Allow customer unvested refunds</label></>}
    {!tx.verifiedWallet&&<Button variant="secondary" disabled={!address} loading={tx.busy} onClick={()=>void tx.signIn()}>Verify merchant wallet</Button>}
    <Button loading={busy} disabled={!tx.verifiedWallet||!isAddress(payout)||payout===zeroAddress||(plan.escrowDays>0&&(!isAddress(arbitrator)||arbitrator===zeroAddress))} onClick={()=>void prepare()}>Prepare plan publication</Button>
   </>:<>
    <p className="break-all text-sm text-dim">Publish {displayUsdc(prepared.amount)} USDC every {prepared.intervalSeconds} seconds; trial {prepared.trialSeconds} seconds; grace {prepared.graceSeconds} seconds; linear vesting {prepared.vestDuration} seconds.</p>
    <p className="break-all text-xs text-dim">Merchant: {prepared.merchant}<br />Payout: {prepared.payout}<br />Arbitrator: {prepared.arbitrator}<br />Customer unvested refunds: {prepared.customerMayRefundUnvested?'Enabled':'Disabled'}</p>
    <label className="flex gap-3 text-sm text-dim"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} />I reviewed these exact immutable plan terms.</label>
    <ContractAction configuration={c} operationKey={`publish:${plan.id}`} label="Publish plan onchain" disabled={!consent||address?.toLowerCase()!==prepared.merchant.toLowerCase()} snapshot={chain.loadSnapshot} target={{kind:'plan',key:prepared.planKey,states:['active'],eventNames:['PlanCreated']}} action={(sdk,write)=>{assertPreparedMerchant(prepared,c,sdk.io.account,plan.id);return sdk.publishPlan(prepared,write)}} />
   </>}
  </>}
  {(error||tx.error)&&<p role="alert" className="text-sm text-caution">{error??tx.error}</p>}
 </div>
}
export function PublishPlanAction({plan}:{plan:Plan}) {
 const can=useCan('catalog'),[open,setOpen]=useState(false)
 if(!can)return null
 return <><Button size="sm" variant="secondary" disabled={plan.status!=='active'} onClick={()=>setOpen(true)}>Publish onchain</Button><Modal open={open} onClose={()=>setOpen(false)} title={`Publish ${plan.name}`}>{open&&<PublishPlanForm plan={plan} />}</Modal></>
}
/** Actual expiring capability creation, never a private invoice UUID link. */
export function CheckoutLinkAction({subscriptionId,invoiceId}:{subscriptionId:string;invoiceId?:string}) {
 const {session}=useAuth(),can=useCan(invoiceId?'invoices':'subscriptions'),orgId=session?.organization?.id
 const [open,setOpen]=useState(false),[url,setUrl]=useState(''),[error,setError]=useState<string>(),[busy,setBusy]=useState(false)
 const create=async()=>{if(!orgId)return;setBusy(true);setError(undefined);try{const result=await chainApi.createCheckout(orgId,{subscriptionId,...(invoiceId?{invoiceId}:{}),expiresInSeconds:86400});setUrl(new URL(result.url,window.location.origin).href)}catch(e){setError(e instanceof Error?e.message:'Checkout link creation failed.')}finally{setBusy(false)}}
 if(!can)return null
 return <><Button size="sm" variant="secondary" onClick={()=>setOpen(true)}>Checkout link</Button><Modal open={open} onClose={()=>setOpen(false)} title="Create secure checkout link"><div className="space-y-4"><p className="text-sm text-dim">Creates a real 24-hour payment capability. Anyone holding this link may view payment terms; payment still requires the verified customer wallet. Share it privately.</p><Button loading={busy} onClick={()=>void create()}>Create 24-hour checkout link</Button>{url&&<label className="block space-y-2 text-sm text-dim"><span>Private checkout URL</span><input aria-label="Private checkout URL" className={merchantInput} readOnly value={url} onFocus={e=>e.target.select()} /><a className="text-cyan underline" href={url} target="_blank" rel="noreferrer">Open checkout</a></label>}{error&&<p role="alert" className="text-sm text-caution">{error}</p>}</div></Modal></>
}
export function MerchantSubscriptionAction({subscriptionId}:{subscriptionId:string}) {
 const can=useCan('subscriptions'),chain=useMerchantChain(),{address}=useAccount(),[open,setOpen]=useState(false),[consent,setConsent]=useState(false)
 const b=chain.snapshot.data?.bindings.find(b=>b.kind==='subscription'&&b.recordId===subscriptionId),c=chain.configuration.data
 if(!can)return null
 return <><Button size="sm" variant="ghost" onClick={()=>setOpen(true)}>Cancel onchain</Button><Modal open={open} onClose={()=>setOpen(false)} title="Cancel subscription onchain"><div className="space-y-4"><WalletButton compact />{chain.snapshot.isPending?<p>Loading verified subscription binding…</p>:!b?<p role="status" className="text-sm text-dim">No onchain subscription binding exists. An incomplete catalog record is not an active onchain subscription.</p>:c&&<><label className="flex gap-3 text-sm text-dim"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} />Cancel future charges. This does not refund prior payments or escrow.</label><ContractAction configuration={c} operationKey={`cancel:${b.key}`} label="Confirm onchain cancellation" disabled={!consent||b.merchant.toLowerCase()!==address?.toLowerCase()} snapshot={chain.loadSnapshot} action={(sdk,write)=>sdk.cancelSubscription(b.key,write)} target={{kind:'subscription',key:b.key,states:['canceled'],eventNames:['SubscriptionCanceled']}} /></>}{chain.snapshot.isError&&<p role="alert">{chain.snapshot.error.message}</p>}</div></Modal></>
}
