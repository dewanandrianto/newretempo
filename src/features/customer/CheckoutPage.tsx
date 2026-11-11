import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { ShieldCheck } from 'lucide-react'
import type { ChainCheckout } from '../../../shared/chain'
import { chainApi, displayUsdc, parseUsdc } from '@/services/blockchain'
import { useRetempoTransactions } from '@/features/onchain/useRetempoTransactions'
import { TransactionStatus, canSubmit } from '@/features/onchain/TransactionStatus'
import type { ProjectionTarget } from '@/features/onchain/proof'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EmptyState, PageSkeleton } from '@/components/ui/States'
import { WalletButton, useUsdcBalance } from '@/components/wallet/WalletButton'
import { checkoutAvailability, checkoutActionsPaused, checkoutPauseMessage, checkoutWindows, assertCheckoutPreparation, checkoutDue, checkoutSubscription } from './model'

function Checkout({checkout:c,token,invoice}:{checkout:ChainCheckout;token:string;invoice:boolean}) {
 const {address,chainId}=useAccount(),balance=useUsdcBalance()
 const tx=useRetempoTransactions(c.configuration,`invoice-payment:${c.subscriptionId}:${c.invoiceId}`)
 const [consent,setConsent]=useState(false),[prepared,setPrepared]=useState<ChainCheckout>()
 const [now,setNow]=useState(()=>Date.now())
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[])
 const availability=checkoutAvailability(c,now)
 const actionsPaused=checkoutActionsPaused(c.configuration)
 const pauseMessage=checkoutPauseMessage(c.configuration)
 const canReadChain=c.configuration.configured&&(!availability||actionsPaused)
 const windows=useQuery({queryKey:['checkout-windows',c.planKey,c.configuration.genesisHash],queryFn:()=>checkoutWindows(c),enabled:canReadChain,retry:false,staleTime:0})
 const subscription=useQuery({queryKey:['checkout-subscription',c.id,c.subscriptionKey],queryFn:()=>checkoutSubscription(c),enabled:canReadChain,retry:false})
 const existing=Boolean(subscription.data&&subscription.data.status!==0)
 const wrongNetwork=Boolean(address&&chainId!==5042002)
 const due=checkoutDue(c,existing)
 const short=balance.formatted!==undefined&&parseUsdc(balance.formatted)<due
 const target=(context:ChainCheckout):ProjectionTarget=>!existing&&c.trialDays>0?{kind:'subscription',recordId:c.subscriptionId,states:['active'],eventNames:['SubscriptionCreated']}:{kind:'payment',recordId:context.paymentId??'not-yet-prepared',states:['succeeded','paid'],eventNames:['SubscriptionPaymentProcessed']}
 const pay=()=>tx.execute(async(sdk,write,remember)=>{
  if(!consent||!windows.data)throw new Error('Review and accept the exact terms first.')
  const bound=await chainApi.prepareCheckout(token,sdk.io.account)
  assertCheckoutPreparation(c,bound);setPrepared(bound);remember(target(bound))
  if(existing&&bound.subscriptionKey)await sdk.renew(bound.subscriptionKey,bound,windows.data,write)
  else await sdk.subscribe(bound,windows.data,write)
 })
 return <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
  <Card className="min-w-0 p-6 sm:p-8">
   <p className="eyebrow">{invoice?'Invoice · ':''}{c.merchantName}</p>
   <h1 className="display mt-3 text-3xl font-semibold text-fg">{c.productName}<span className="block text-dim">{c.planName}</span></h1>
   <p className="mt-4 text-sm leading-relaxed text-dim">{c.description}</p>
   <p className="num mt-8 break-words text-4xl font-semibold text-fg">{displayUsdc(c.amount)} <span className="text-lg font-normal text-dim">USDC / {c.interval}</span></p>
   <dl className="mt-8 space-y-4 text-sm">
    <div className="flex justify-between gap-4"><dt className="text-dim">Billing interval</dt><dd className="num text-fg">{c.intervalSeconds.toLocaleString()} seconds</dd></div>
    <div className="flex justify-between gap-4"><dt className="text-dim">Trial</dt><dd className="text-fg">{c.trialDays?`${c.trialDays} days`:'No trial'}</dd></div>
    <div className="flex justify-between gap-4"><dt className="text-dim">Vesting</dt><dd className="text-fg">{c.escrowDays?`${c.escrowDays} days, linear`:'Direct to payout'}</dd></div>
   </dl>
   {c.trialDays>0&&!existing&&<p className="mt-6 text-sm text-dim">Nothing is charged during the trial. A later payment requires a manual renewal or a separately authorized finite mandate.</p>}
   {c.escrowDays>0&&<div className="mt-6 space-y-3 border-t border-line pt-5 text-sm text-dim"><p className="flex gap-2 font-medium text-fg"><ShieldCheck className="size-4 text-cyan" /> Escrow terms</p><p>Payments vest continuously; this is not a full hold or a guaranteed full refund. {c.customerMayRefundUnvested?'You may refund the eligible unvested balance.':'Unvested customer refunds are not enabled.'}</p>{windows.data&&<p>Response window: <strong className="num text-fg">{windows.data.responseWindow.toLocaleString()} seconds</strong>. Resolution timeout from dispute opening: <strong className="num text-fg">{windows.data.resolutionTimeout.toLocaleString()} seconds</strong>. Arbitration ends exactly at that deadline; only expiration applies afterward.</p>}<p className="break-all text-xs">Arbitrator: {c.arbitrator}</p></div>}
   <details className="mt-6 text-xs text-faint"><summary className="cursor-pointer py-2">Verify recipient and contract</summary><dl className="mt-3 space-y-2 break-all"><dt>Merchant</dt><dd>{c.merchant}</dd><dt>Payout</dt><dd>{c.payout}</dd><dt>Manager</dt><dd>{c.configuration.manager??'Not configured'}</dd><dt>Plan key</dt><dd>{c.planKey}</dd></dl></details>
  </Card>
  <Card className="h-fit min-w-0 space-y-5 p-6">
   <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold text-fg">Review & subscribe</h2><WalletButton compact /></div>
   <p className="text-xs text-dim">{c.configuration.mode==='local'?'Local preview. No payment is processed.':'Configured payment network'}</p>
   {pauseMessage&&<p role="status" className="rounded-lg border border-line p-3 text-sm text-caution">{pauseMessage}</p>}
   <dl className="flex justify-between gap-3 text-sm"><dt className="text-dim">Due today</dt><dd className="num break-all text-fg">{displayUsdc(due)} USDC + gas</dd></dl>
   {availability&&availability!==pauseMessage&&<p role="status" className="rounded-lg border border-line p-3 text-sm text-caution">{availability}</p>}
   {wrongNetwork&&<p role="alert" className="text-sm text-caution">Wrong network. Switch your wallet to the network used for this invoice before continuing.</p>}
   {short&&<p role="alert" className="text-sm text-caution">Insufficient USDC. Add funds for the exact payment and native USDC gas.</p>}
   {canReadChain&&windows.isPending&&<p className="text-sm text-dim">Loading live contract terms…</p>}
   {subscription.isError&&<p role="alert" className="text-sm text-caution">Subscription state could not be verified. <button className="underline" onClick={()=>void subscription.refetch()}>Retry state</button></p>}
   {windows.isError&&<div role="alert" className="text-sm text-caution">Contract terms could not be verified. <button className="underline" onClick={()=>void windows.refetch()}>Retry terms</button></div>}
   {!availability&&<label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed text-dim"><input type="checkbox" className="mt-1 size-4 accent-cyan" checked={consent} onChange={e=>setConsent(e.target.checked)} /><span>I accept the displayed plan, payout, arbitrator and exact escrow windows. I authorize only {displayUsdc(due)} USDC now. No recurring mandate is created.</span></label>}
   {address&&!tx.verifiedWallet&&<Button variant="secondary" className="w-full" loading={tx.busy} disabled={wrongNetwork} onClick={()=>void tx.signIn()}>Sign in with this wallet</Button>}
   <Button size="lg" className="w-full" loading={tx.busy} disabled={Boolean(availability)||wrongNetwork||short||!address||!tx.verifiedWallet||!consent||!windows.data||subscription.isPending||subscription.isError||!canSubmit(tx.state.phase)} onClick={()=>void pay()}>{existing?'Approve exact amount & renew':c.trialDays>0?'Start trial':'Approve exact amount & subscribe'}</Button>
   <TransactionStatus state={tx.state} error={tx.error} busy={tx.busy} onSync={()=>void tx.sync(target(prepared??c))} onResume={()=>void tx.resume()} />
   {tx.state.phase==='confirmed-indexing-pending'&&!prepared?.paymentId&&!c.paymentId&&c.trialDays===0&&<p className="text-xs text-dim">Confirmation is retained. Open the wallet-owned portal to verify this payment; never submit this checkout again.</p>}
   <Link to="/portal" className="inline-block text-sm text-cyan underline underline-offset-4">Manage subscriptions in your portal</Link>
   <p className="text-xs leading-relaxed text-faint">Issuer blocklisting can prevent transactions, including claims or refunds. Retempo cannot override issuer policy. Already-created credit may be recoverable to an unblocked payout via a clean relayer using the contract's EIP-712 authorization; no hosted relayer is provided here.</p>
  </Card>
 </div>
}
export function CapabilityCheckout({token,invoice=false}:{token:string;invoice?:boolean}) {
 const query=useQuery({queryKey:['public-checkout',invoice,token],queryFn:()=>chainApi.checkout(token,invoice),enabled:Boolean(token),retry:false,refetchOnWindowFocus:false})
 if(!token)return <EmptyState title="Missing payment link" description="Use the complete capability link supplied by the merchant." />
 if(query.isPending)return <PageSkeleton />
 if(query.isError)return <Card className="space-y-4 p-6"><h1 className="text-xl text-fg">Payment link unavailable</h1><p role="alert" className="text-sm text-dim">{query.error.message} This may be an expired or revoked link. No new payment has been submitted by this page.</p><Button variant="secondary" onClick={()=>void query.refetch()}>Retry loading link</Button></Card>
 return <Checkout key={query.data.id} checkout={query.data} token={token} invoice={invoice} />
}
export default function CheckoutPage(){const {sessionId=''}=useParams();return <CapabilityCheckout token={sessionId} />}
