import type { ChainProjection } from '../../../shared/chain'
import type { WorkerBindings } from '../types'
import { snapshot } from './client'
const kinds={subscriptions:'subscription',invoices:'invoice',payments:'payment',escrows:'escrow'} as const
const statuses:Record<string,readonly string[]>={subscription:['incomplete','trialing','active','past_due','paused','canceled'],invoice:['draft','open','paid','void','uncollectible'],payment:['pending','processing','succeeded','failed','canceled'],escrow:['pending_funding','funded','released','refunded','settled','disputed']}
export function overlay<T extends {id:unknown;status:unknown}>(record:T,kind:string,projections:ChainProjection[]):T {
 const p=projections.find(p=>p.kind===kind&&p.recordId===record.id)
 if(!p)return record
 let status=p.state
 if(kind==='payment'&&status==='paid')status='succeeded'
 if(kind==='subscription'&&status==='pending')status='incomplete'
 if(kind==='escrow'){
  if(p.values.dispute==='open')status='disputed'
  else if(status==='active')status='funded'
  else if(status==='missing'||status==='pending')status='pending_funding'
  else if(status==='closed')status=p.values.outcome==='fully_vested'?'released':p.values.outcome==='refunded'?'refunded':'settled'
 }
 if(!statuses[kind]?.includes(status))return record
 const projected:Record<string,unknown>={...record,status}
 if(typeof p.values.amount==='string'&&/^(0|[1-9][0-9]*)$/.test(p.values.amount)&&kind!=='invoice')projected.amount=p.values.amount
 if(kind==='payment')projected.txHash=p.transactionHash
 if(kind==='invoice'&&p.state==='paid')projected.amountPaid=('total' in record?record.total:p.values.amount)??'0'
 if(kind==='subscription'){
  if(typeof p.values.nextChargeAt==='string')projected.currentPeriodEnd=p.values.nextChargeAt
  const payments=projections.filter(v=>v.kind==='payment'&&v.state==='paid'&&v.values.subKey===p.key&&typeof v.values.chargeNumber==='string'&&/^[0-9]+$/.test(v.values.chargeNumber))
  const latest=payments.reduce<ChainProjection|undefined>((last,v)=>!last||BigInt(String(v.values.chargeNumber))>BigInt(String(last.values.chargeNumber))?v:last,undefined)
  if(typeof latest?.values.periodStart==='string')projected.currentPeriodStart=latest.values.periodStart
  if(typeof p.values.currentPeriodStart==='string')projected.currentPeriodStart=p.values.currentPeriodStart
  if(typeof p.values.currentPeriodEnd==='string')projected.currentPeriodEnd=p.values.currentPeriodEnd
 }
 return projected as T
}
export async function overlayBilling<T extends {id:unknown;status:unknown}>(env:WorkerBindings,orgId:string,collection:keyof typeof kinds,records:T[]):Promise<T[]>{
 const state=await snapshot(env,orgId)
 return records.map(r=>overlay(r,kinds[collection],state.projections))
}
