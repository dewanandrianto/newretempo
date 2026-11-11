import type { Abi, Address, Hash } from 'viem'
import { erc20Abi, zeroAddress } from 'viem'
import managerJson from '../../../contracts/abi/RetempoSubscriptionManager.json'
import escrowJson from '../../../contracts/abi/RetempoEscrow.json'
import type { ChainCheckout, ChainConfiguration, ChainPlanPreparation } from '../../../shared/chain'
import { assertDeployment, assertPlan, verifyWalletWorld, type PlanTerms, type RpcRequest } from './guards'
import { baseUnits } from './amounts'
import type { ReceiptStatus, WriteTransaction } from './transactions'
export const managerAbi = managerJson as Abi
export const escrowAbi = escrowJson as Abi
export interface ContractCall { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }
export interface ChainIO { account: Address; reader: RpcRequest; wallet: RpcRequest; read: (call: ContractCall) => Promise<unknown>; simulate: (call: ContractCall) => Promise<void>; send: (call: ContractCall) => Promise<Hash>; receipt: (hash: Hash) => Promise<ReceiptStatus> }
export interface EscrowWindows { responseWindow: number; resolutionTimeout: number }
export interface SubscriptionState { customer: Address; planKey: Hash; amount: bigint; interval: number; grace: number; nextChargeAt: number; chargeCount: number; acceptedArbitrator: Address; status: number }
export interface EscrowState { merchant: Address; customer: Address; arbitrator: Address; amount: bigint; claimed: bigint; refunded: bigint; frozen: bigint; vestStart: number; vestDuration: number; responseWindow: number; resolutionTimeout: number; disputedAt: number; customerMayRefundUnvested: boolean; merchantResponded: boolean; status: number; dispute: number }
export interface MandateBudget { perChargeCap: string; totalCap: string; expiry: number }
const same = (a: string,b: string) => a.toLowerCase()===b.toLowerCase()
export class RetempoClient {
 constructor(readonly configuration: ChainConfiguration, readonly io: ChainIO) {}
 private call(target: 'manager'|'escrow'|'usdc', functionName:string,args:readonly unknown[]=[]):ContractCall {
  assertDeployment(this.configuration)
  return {address:this.configuration[target],abi:target==='manager'?managerAbi:target==='escrow'?escrowAbi:erc20Abi,functionName,args}
 }
 async read<T>(target:'manager'|'escrow'|'usdc',name:string,args:readonly unknown[]=[]):Promise<T> {return await this.io.read(this.call(target,name,args)) as T}
 async assertWallet():Promise<void> {
  await verifyWalletWorld(this.configuration,this.io.reader,this.io.wallet)
  const [usdc,escrow,manager,decimals] = await Promise.all([this.read<Address>('manager','usdc'),this.read<Address>('manager','escrow'),this.read<Address>('escrow','manager'),this.read<number>('usdc','decimals')])
  if(!same(usdc,this.configuration.usdc)||!same(escrow,this.configuration.escrow!)||!same(manager,this.configuration.manager!)||decimals!==6) throw new Error('Deployment links or token decimals do not match the verified configuration.')
 }
 async windows():Promise<EscrowWindows> { const [responseWindow,resolutionTimeout]=await Promise.all([this.read<number>('escrow','responseWindow'),this.read<number>('escrow','resolutionTimeout')]);return {responseWindow,resolutionTimeout} }
 async assertWindows(expected:EscrowWindows):Promise<void> {
  const current=await this.windows()
  if(current.responseWindow!==expected.responseWindow||current.resolutionTimeout!==expected.resolutionTimeout) throw new Error('Dispute windows changed. Review the exact new terms before continuing.')
 }
 getPlan(key:Hash) {return this.read<PlanTerms & {grace:number}>('manager','getPlan',[key])}
 getSubscription(key:Hash) {return this.read<SubscriptionState>('manager','getSubscription',[key])}
 getEscrow(key:Hash) {return this.read<EscrowState>('escrow','getEscrow',[key])}
 getMandate(key:Hash) {return this.read<{perChargeCap:bigint;totalCap:bigint;spent:bigint;expiry:number;nonce:number;active:boolean}>('manager','getMandate',[key])}
 acceptedEscrowTerms(key:Hash) {return this.read<readonly [number,number]>('manager','acceptedEscrowTerms',[key])}
 canCharge(key:Hash) {return this.read<readonly [boolean,number]>('manager','canCharge',[key])}
 async balance() {return this.read<bigint>('usdc','balanceOf',[this.io.account])}
 async timestamp():Promise<number> { const b=await this.io.reader({method:'eth_getBlockByNumber',params:['latest',false]}); if(!b||typeof b!=='object'||!('timestamp'in b)||typeof b.timestamp!=='string')throw new Error('Could not read chain time.');return Number(BigInt(b.timestamp)) }
 private async transact(target:'manager'|'escrow',name:string,args:readonly unknown[],write:WriteTransaction):Promise<void> {
  await this.assertWallet()
  const call=this.call(target,name,args)
  await this.io.simulate(call)
  await write('payment',()=>this.io.send(call),hash=>this.io.receipt(hash))
 }
 private async approve(amount:bigint,write:WriteTransaction,check:()=>Promise<void>,requireBalance=true):Promise<void> {
  await check()
  if(amount===0n)return
  if(requireBalance&&await this.balance()<amount)throw new Error('Insufficient USDC balance for this payment. Native USDC is also required for gas.')
  const allowance=await this.read<bigint>('usdc','allowance',[this.io.account,this.configuration.manager!])
  if(allowance===amount)return
  // Replace, never increment or grant an unlimited allowance. Existing broader approvals are reduced.
  await this.assertWallet();await check()
  const call=this.call('usdc','approve',[this.configuration.manager!,amount])
  await this.io.simulate(call)
  await write('approval',()=>this.io.send(call),hash=>this.io.receipt(hash))
  await check()
 }
 async publishPlan(p:ChainPlanPreparation,write:WriteTransaction):Promise<void> {
  if(!same(p.merchant,this.io.account)||!same(p.configuration.manager??zeroAddress,this.configuration.manager??zeroAddress))throw new Error('Connect the prepared merchant wallet and deployment.')
  const key=await this.read<Hash>('manager','planKey',[this.io.account,p.externalRef])
  if(!same(key,p.planKey))throw new Error('Prepared plan identity mismatch.')
  await this.transact('manager','createPlan',[p.externalRef,p.payout,baseUnits(p.amount),p.intervalSeconds,p.trialSeconds,p.graceSeconds,p.vestDuration,p.arbitrator,p.customerMayRefundUnvested],write)
 }
 async subscribe(c:ChainCheckout,windows:EscrowWindows,write:WriteTransaction):Promise<void> {
  assertDeployment(this.configuration)
  if(c.status!=='open'||Date.parse(c.expiresAt)<=Date.now()||!c.customer||!same(c.customer,this.io.account)||!c.externalRef||!c.subscriptionKey||!same(c.configuration.manager??zeroAddress,this.configuration.manager))throw new Error('Checkout is expired, complete, unprepared, or bound to another wallet/deployment.')
  const check=async()=>{
   await this.assertWallet();assertPlan(c,await this.getPlan(c.planKey))
   if(c.escrowDays>0)await this.assertWindows(windows)
   const key=await this.read<Hash>('manager','subscriptionKey',[this.io.account,c.externalRef!])
   if(!same(key,c.subscriptionKey!))throw new Error('Prepared subscription identity mismatch.')
   if((await this.getSubscription(key)).status!==0)throw new Error('Subscription already exists. Sync the portal instead of paying again.')
  }
  await check()
  await this.approve(c.trialDays>0?0n:baseUnits(c.amount),write,check)
  await check()
  await this.transact('manager','subscribe',[c.externalRef,c.planKey,c.escrowDays>0?c.arbitrator:zeroAddress],write)
 }
 private async ownedSubscription(key:Hash,allowMerchant=false):Promise<SubscriptionState> {
  const s=await this.getSubscription(key)
  const merchant=allowMerchant?(await this.getPlan(s.planKey)).merchant:''
  if(!same(s.customer,this.io.account)&&!same(merchant,this.io.account))throw new Error('Use the permitted subscription wallet to continue.')
  return s
 }
 async renew(key:Hash,expected:ChainCheckout,windows:EscrowWindows,write:WriteTransaction):Promise<void> {
  const initial=await this.ownedSubscription(key)
  const check=async()=>{
   const s=await this.ownedSubscription(key); assertPlan(expected,await this.getPlan(s.planKey))
   if(s.status!==1||s.chargeCount!==initial.chargeCount||s.amount!==baseUnits(expected.amount)||!same(s.planKey,expected.planKey))throw new Error('Subscription changed. Refresh before renewing.')
   if(expected.escrowDays>0){await this.assertWindows(windows);const accepted=await this.acceptedEscrowTerms(key);if(accepted[0]!==windows.responseWindow||accepted[1]!==windows.resolutionTimeout)throw new Error('Accept the new escrow terms first. This does not recreate a mandate.')}
  }
  await check();await this.approve(initial.amount,write,check);await check();await this.transact('manager','renew',[key],write)
 }
 async cancelSubscription(key:Hash,write:WriteTransaction) {await this.ownedSubscription(key,true);await this.transact('manager','cancelSubscription',[key],write)}
 async revokeMandate(key:Hash,write:WriteTransaction) {await this.ownedSubscription(key);await this.transact('manager','revokeMandate',[key],write)}
 async acceptEscrowTerms(key:Hash,expected:EscrowWindows,write:WriteTransaction) {await this.ownedSubscription(key);await this.assertWindows(expected);await this.transact('manager','acceptEscrowTerms',[key,expected.responseWindow,expected.resolutionTimeout],write)}
 async createMandate(key:Hash,budget:MandateBudget,expected:ChainCheckout,windows:EscrowWindows,write:WriteTransaction):Promise<void> {
  const per=baseUnits(budget.perChargeCap),total=baseUnits(budget.totalCap)
  if(per===0n||total<per||total>1000000000000000n)throw new Error('Choose an explicit finite mandate budget and per-charge cap.')
  const s=await this.ownedSubscription(key),now=await this.timestamp()
  if(s.status!==1||per<s.amount||!Number.isSafeInteger(budget.expiry)||budget.expiry<=now||budget.expiry>now+366*86400)throw new Error('Invalid mandate cap, expiry, or inactive subscription.')
  const p=await this.getPlan(s.planKey)
  const check=async()=>{await this.ownedSubscription(key);assertPlan(expected,await this.getPlan(s.planKey));if(p.vestDuration>0){await this.assertWindows(windows);const a=await this.acceptedEscrowTerms(key);if(a[0]!==windows.responseWindow||a[1]!==windows.resolutionTimeout)throw new Error('Accept current escrow terms before creating a new finite mandate.')}}
  // Budget approval does not consume it. Manual payments do not consume mandate caps.
  await this.approve(total,write,check,false);await check();await this.transact('manager','createMandate',[key,per,total,budget.expiry],write)
 }
 private async escrowActor(key:Hash,role:'merchant'|'customer'|'arbitrator') {const e=await this.getEscrow(key);if(!same(e[role],this.io.account))throw new Error(`Connect the escrow ${role} wallet.`);return e}
 async claim(key:Hash,write:WriteTransaction) {await this.escrowActor(key,'merchant');await this.transact('escrow','claim',[key],write)}
 async refundUnvested(key:Hash,write:WriteTransaction) {const e=await this.escrowActor(key,'customer');if(!e.customerMayRefundUnvested)throw new Error('Unvested refunds are not permitted by these terms.');await this.transact('escrow','customerRefundUnvested',[key],write)}
 async merchantRefund(key:Hash,amount:string,write:WriteTransaction) {await this.escrowActor(key,'merchant');await this.transact('escrow','merchantRefund',[key,baseUnits(amount)],write)}
 async openDispute(key:Hash,amount:string,reasonHash:Hash,write:WriteTransaction) {await this.escrowActor(key,'customer');await this.transact('escrow','openDispute',[key,baseUnits(amount),reasonHash],write)}
 async respondToDispute(key:Hash,responseHash:Hash,write:WriteTransaction) {await this.escrowActor(key,'merchant');await this.transact('escrow','respondToDispute',[key,responseHash],write)}
 async resolveDispute(key:Hash,merchantAmount:string,rulingHash:Hash,write:WriteTransaction) {const e=await this.escrowActor(key,'arbitrator');if(await this.timestamp()>=e.disputedAt+e.resolutionTimeout)throw new Error('The arbitration deadline is exclusive and has passed. Use expiration.');await this.transact('escrow','resolveDispute',[key,baseUnits(merchantAmount),rulingHash],write)}
 async expireDispute(key:Hash,write:WriteTransaction) {await this.transact('escrow','expireDispute',[key],write)}
 async withdraw(to:Address,write:WriteTransaction) {await this.transact('escrow','withdraw',[to],write)}
 async withdrawToPayout(account:Address,write:WriteTransaction) {await this.transact('escrow','withdrawToPayout',[account],write)}
 async setPayoutAddress(to:Address,write:WriteTransaction) {await this.transact('escrow','setPayoutAddress',[to],write)}
 async setPayoutAddressBySig(account:Address,to:Address,deadline:bigint,signature:Hash,write:WriteTransaction) {await this.transact('escrow','setPayoutAddressBySig',[account,to,deadline,signature],write)}
 async setPlanPayout(key:Hash,to:Address,write:WriteTransaction) {if(!same((await this.getPlan(key)).merchant,this.io.account))throw new Error('Connect the plan merchant wallet.');await this.transact('manager','setPlanPayout',[key,to],write)}
}
