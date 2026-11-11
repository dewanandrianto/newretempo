import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import type { ChainBinding, ChainSnapshot } from '../../../shared/chain'
import { chainApi } from '@/services/blockchain'
import { useRetempoTransactions } from '@/features/onchain/useRetempoTransactions'
import { WalletButton } from '@/components/wallet/WalletButton'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState, PageSkeleton } from '@/components/ui/States'
import { SubscriptionCard } from './SubscriptionCard'
import { EscrowCard, CreditCard } from './EscrowCard'
import { PrivyAuthButtonLazy } from '@/features/auth/PrivyAuthButtonLazy'
import { useRuntimeAuthConfig } from '@/features/auth/privyRuntimeContext'

function WalletRecords({snapshot}:{snapshot:ChainSnapshot}) {
 const {address}=useAccount()
 const owned=(binding:ChainBinding)=>!binding.customer||binding.customer.toLowerCase()===address?.toLowerCase()
 const subscriptions=snapshot.bindings.filter(b=>b.kind==='subscription'&&owned(b))
 const escrows=snapshot.bindings.filter(b=>b.kind==='escrow'&&owned(b))
 const payments=snapshot.projections.filter(p=>p.kind==='payment')
 return <div className="space-y-6">
  <section className="space-y-4" aria-labelledby="subscriptions-title"><h2 id="subscriptions-title" className="text-xl font-semibold text-fg">Your subscriptions</h2>{subscriptions.length?subscriptions.map(b=><SubscriptionCard key={`${b.orgId}:${b.key}`} binding={b} snapshot={snapshot} />):<EmptyState title="No subscriptions" description="Subscriptions associated with your verified wallet will appear here." />}</section>
  <section className="space-y-4" aria-labelledby="escrows-title"><h2 id="escrows-title" className="text-xl font-semibold text-fg">Escrow & disputes</h2>{escrows.length?escrows.map(b=><EscrowCard key={`${b.orgId}:${b.key}`} binding={b} configuration={snapshot.configuration} />):<Card className="p-5 text-sm text-dim">No escrow records for this wallet.</Card>}</section>
  <CreditCard configuration={snapshot.configuration} />
  <section className="space-y-3" aria-labelledby="payment-history"><h2 id="payment-history" className="text-xl font-semibold text-fg">Verified payment history</h2>{payments.length?<ul className="space-y-3">{payments.map(p=><Card key={`${p.orgId}:${p.recordId}`} className="min-w-0 p-5"><p className="text-sm font-medium text-fg">{p.state}</p><p className="mono mt-2 break-all text-xs text-dim">{p.transactionHash??'No verified transaction'}</p><p className="mt-2 text-xs text-faint">Invoice capabilities are private and expiring. Ask the merchant for a fresh link; private invoice IDs are not public payment links.</p></Card>)}</ul>:<Card className="p-5 text-sm text-dim">No verified payments yet. Pending records are not settlement.</Card>}</section>
 </div>
}
export default function PortalPage() {
 const {address,chainId}=useAccount()
 const {enabled:privyEnabled}=useRuntimeAuthConfig()
 const config=useQuery({queryKey:['chain-configuration'],queryFn:chainApi.configuration,retry:false})
 const tx=useRetempoTransactions(config.data,'portal-auth')
 const snapshot=useQuery({queryKey:['customer-chain',address],queryFn:chainApi.customerSnapshot,enabled:Boolean(config.data?.configured&&tx.verifiedWallet),retry:false,refetchInterval:15000})
 return <div className="space-y-6">
	 <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="eyebrow">Customer portal</p><h1 className="display mt-2 text-3xl font-semibold text-fg">Your billing, under your control</h1><p className="mt-2 max-w-xl text-sm text-dim">Wallet-owned subscriptions and independently verified payments. Signing in does not authorize spending.</p></div><WalletButton /></div>
		 {config.isPending&&<PageSkeleton />}
		 {config.isError&&<Card className="space-y-3 p-5"><p role="alert" className="text-caution">{config.error.message}</p><Button onClick={()=>void config.refetch()}>Retry configuration</Button></Card>}
       {config.data&&!config.data.configured&&<EmptyState title="Deployment disabled" description={config.data.reason??'No verified payment deployment is configured. No transaction can be sent.'} />}
       {config.data?.mode==='local'&&<p className="rounded-xl border border-caution/30 p-3 text-sm text-caution">Local preview. Payments cannot be processed.</p>}
       {config.data?.configured&&!tx.verifiedWallet&&<Card className="space-y-4 p-5 sm:p-6"><h2 className="text-lg text-fg">{address?'Verify your wallet to view billing':'Sign in to access billing'}</h2><p className="text-sm leading-relaxed text-dim">{address?'Sign a one-time message to prove control of this wallet. This does not authorize spending.':'Choose a sign-in method to continue. Signing in does not authorize spending.'}</p>{!address&&privyEnabled&&<PrivyAuthButtonLazy mode="wallet" />} {address&&chainId!==5042002&&<p className="text-sm text-caution">This wallet is not ready to verify billing. Select a supported wallet and try again.</p>}{address&&<Button disabled={chainId!==5042002} loading={tx.busy} onClick={()=>void tx.signIn()}>Verify wallet with a one-time message</Button>}{tx.error&&<p role="alert" className="text-sm text-caution">{tx.error}</p>}</Card>}
		 {tx.verifiedWallet&&snapshot.isPending&&config.data?.configured&&<PageSkeleton />}
		 {tx.verifiedWallet&&snapshot.isError&&<Card className="space-y-3 p-5"><p role="alert" className="text-sm text-caution">{snapshot.error.message}</p><Button onClick={()=>void snapshot.refetch()}>Retry wallet-owned records</Button></Card>}
	 {tx.verifiedWallet&&snapshot.data&&<WalletRecords snapshot={snapshot.data} />}
 </div>
}
