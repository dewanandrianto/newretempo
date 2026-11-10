import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { keccak256, stringToHex } from 'viem'
import type { ChainBinding, ChainConfiguration, ChainSnapshot } from '../../../shared/chain'
import { useCan } from '@/features/auth/permissions'
import { WalletButton } from '@/components/wallet/WalletButton'
import { CreditCard } from '@/features/customer/EscrowCard'
import { displayUsdc, parseUsdc } from '@/services/blockchain'
import { ContractAction } from './ContractAction'
import { useRetempoTransactions } from './useRetempoTransactions'
import { merchantEscrowPermissions } from './merchantModel'
import { merchantInput, useMerchantChain } from './MerchantActions'

function EscrowActions({binding:b,configuration:c,snapshot}:{binding:ChainBinding;configuration:ChainConfiguration;snapshot:()=>Promise<ChainSnapshot>}) {
 const {address}=useAccount(),tx=useRetempoTransactions(c,`escrow-read:${b.key}`,snapshot)
 const [amount,setAmount]=useState(''),[evidence,setEvidence]=useState(''),[consent,setConsent]=useState(false)
 const query=useQuery({queryKey:['merchant-chain','escrow',b.key,address,c.genesisHash],queryFn:async()=>{const sdk=tx.client();const [escrow,free,claimable,now]=await Promise.all([sdk.getEscrow(b.key),sdk.read<bigint>('escrow','freeBalanceOf',[b.key]),sdk.read<bigint>('escrow','claimableAmount',[b.key]),sdk.timestamp()]);return {escrow,free,claimable,now}},enabled:Boolean(address),retry:false,refetchInterval:10000})
 if(!address)return <p className="text-sm text-dim">Connect the permitted merchant or arbitrator wallet.</p>
 if(query.isPending)return <p className="text-sm text-dim">Reading live escrow permissions…</p>
 if(query.isError)return <p role="alert" className="text-sm text-caution">{query.error.message}</p>
 const {escrow:e,free,claimable,now}=query.data,p=merchantEscrowPermissions(e,address,now)
 const value=(()=>{try{return parseUsdc(amount)}catch{return null}})(),hash=keccak256(stringToHex(evidence))
 const common={configuration:c,snapshot},target={kind:'escrow' as const,key:b.key,states:['active','closed']}
 return <section className="space-y-4 rounded-xl border border-line p-4" data-testid={`merchant-escrow-${b.recordId}`}>
  <h3 className="break-all text-sm font-medium text-fg">Escrow {b.recordId}</h3>
  <p className="text-sm text-dim">Claimable now: {displayUsdc(claimable)} USDC · Free balance: {displayUsdc(free)} USDC. Claims and refunds create credit; withdrawal is separate.</p>
  {p.claim&&<ContractAction {...common} operationKey={`claim:${b.key}:${e.claimed}`} label="Claim vested funds to credit" disabled={claimable===0n} action={(sdk,write)=>sdk.claim(b.key,write)} target={{...target,eventNames:['VestedClaimed']}} />}
  {(p.refund||p.respond||p.resolve)&&<><label className="block space-y-2 text-sm text-dim"><span>Exact refund or ruling amount (USDC)</span><input className={merchantInput} inputMode="decimal" value={amount} onChange={ev=>{setAmount(ev.target.value);setConsent(false)}} /></label><label className="block space-y-2 text-sm text-dim"><span>Response or ruling evidence to hash</span><textarea className={merchantInput} value={evidence} maxLength={4000} onChange={ev=>{setEvidence(ev.target.value);setConsent(false)}} /></label><p className="text-xs text-faint">Only a Keccak-256 commitment is submitted. Preserve the original evidence separately; this does not upload it.</p><label className="flex gap-3 text-sm text-dim"><input type="checkbox" checked={consent} onChange={ev=>setConsent(ev.target.checked)} />I reviewed the exact amount and evidence for the selected action.</label></>}
  {p.refund&&<ContractAction {...common} operationKey={`merchant-refund:${b.key}:${e.refunded}`} label="Refund exact amount to customer credit" disabled={!consent||value===null||value<=0n||value>free} action={(sdk,write)=>sdk.merchantRefund(b.key,value!.toString(),write)} target={{...target,eventNames:['RefundCredited']}} />}
  {p.respond&&<ContractAction {...common} operationKey={`respond:${b.key}:${e.disputedAt}`} label="Submit dispute response commitment" disabled={!consent||!evidence.trim()} action={(sdk,write)=>sdk.respondToDispute(b.key,hash,write)} target={{kind:'dispute',key:b.key,states:['open'],eventNames:['DisputeResponded']}} />}
  {p.resolve&&<ContractAction {...common} operationKey={`resolve:${b.key}:${e.disputedAt}`} label="Allocate frozen scope as arbitrator" disabled={!consent||value===null||value>e.frozen} action={(sdk,write)=>sdk.resolveDispute(b.key,value!.toString(),hash,write)} target={{kind:'dispute',key:b.key,states:['resolved'],eventNames:['DisputeResolved']}}><p className="text-sm text-dim">Frozen scope {displayUsdc(e.frozen)} USDC. Enter the merchant share; the remainder becomes customer credit. Arbitration ends exactly at {new Date((e.disputedAt+e.resolutionTimeout)*1000).toLocaleString()}.</p></ContractAction>}
  {p.expire&&<ContractAction {...common} operationKey={`expire:${b.key}:${e.disputedAt}`} label="Expire timed-out dispute" action={(sdk,write)=>sdk.expireDispute(b.key,write)} target={{kind:'dispute',key:b.key,states:['resolved'],eventNames:['DisputeExpired']}} />}
 </section>
}
/** Insert once on the merchant Escrow page. Reads only this session's organization snapshot. */
export function MerchantEscrowControls({escrowId}:{escrowId?:string}) {
 const can=useCan('escrows'),chain=useMerchantChain(),c=chain.configuration.data
 if(!can)return null
 if(chain.configuration.isPending)return <p>Loading deployment…</p>
 if(!c?.configured)return <p className="text-sm text-dim">{c?.reason??'Onchain escrow controls are disabled.'}</p>
 const bindings=chain.snapshot.data?.bindings.filter(b=>b.kind==='escrow'&&(!escrowId||b.recordId===escrowId))??[]
 return <div className="space-y-5"><h2 className="text-lg font-semibold text-fg">Onchain escrow actions</h2><WalletButton compact />{chain.snapshot.isError&&<p role="alert" className="text-sm text-caution">{chain.snapshot.error.message}</p>}{bindings.map(b=><EscrowActions key={b.key} binding={b} configuration={c} snapshot={chain.loadSnapshot} />)}{!bindings.length&&<p className="text-sm text-dim">No bound escrows for this organization.</p>}<CreditCard configuration={c} /></div>
}
