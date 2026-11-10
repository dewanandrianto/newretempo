import { expect, it } from 'vitest'
import { RetempoClient, type ContractCall, type ChainIO } from '../../src/services/blockchain/client'
import { configuration, checkout, plan } from './fixtures'
import type { WriteTransaction } from '../../src/services/blockchain/transactions'
const hash = `0x${'ab'.repeat(32)}` as const
const owner = '0x3333333333333333333333333333333333333333' as const
function fixture() {
 const sent: ContractCall[]=[]; let currentPlan = {...plan}; let allowance = 0n
 const io: ChainIO = {
  account: owner,
  reader: ({method}) => Promise.resolve(method==='eth_chainId' ? '0x13b2' : method==='eth_getBlockByNumber' ? {hash: configuration.genesisHash} : '0x1234'),
  wallet: ({method}) => Promise.resolve(method==='eth_chainId' ? '0x13b2' : method==='eth_getBlockByNumber' ? {hash: configuration.genesisHash} : '0x1234'),
  read: call => Promise.resolve(({ getPlan:currentPlan, getSubscription:{customer:owner, planKey:checkout.planKey, status:0, amount:BigInt(checkout.amount)}, subscriptionKey: checkout.planKey, usdc:configuration.usdc, escrow:configuration.escrow, manager:configuration.manager, decimals:6, balanceOf:10n**30n, allowance, responseWindow:86400, resolutionTimeout:172800 }[call.functionName])),
  simulate: () => Promise.resolve(), send: call => {sent.push(call); if(call.functionName==='approve') allowance=call.args[1] as bigint; return Promise.resolve(hash)}, receipt:()=>Promise.resolve('success'),
 }
 const write:WriteTransaction=async (_kind,send,receipt)=>{await receipt(await send())}
 return {sdk:new RetempoClient(configuration,io),io,write,sent,setPlan:(p:typeof plan)=>{currentPlan=p}}
}
it('publishes server-prepared plan identity with exact immutable contract arguments',async()=>{
 const f=fixture(),read=f.io.read
 f.io.read=async c=>c.functionName==='planKey'?checkout.planKey:read(c)
 const prepared={configuration,planId:'plan',externalRef:hash,planKey:checkout.planKey,merchant:owner,payout:owner,amount:'1000001',intervalSeconds:604800,trialSeconds:0,graceSeconds:86400,vestDuration:604800,arbitrator:configuration.escrow!,customerMayRefundUnvested:true}
 await f.sdk.publishPlan(prepared,f.write)
 expect(f.sent.map(c=>c.functionName)).toEqual(['createPlan'])
 expect(f.sent[0].args).toEqual([hash,owner,1000001n,604800,0,86400,604800,configuration.escrow,true])
})
it('cancels through the real SDK contract route for the permitted merchant only',async()=>{
 const f=fixture(),read=f.io.read
 f.io.read=async c=>c.functionName==='getPlan'?{...plan,merchant:owner}:c.functionName==='getSubscription'?{customer:configuration.escrow!,planKey:checkout.planKey,status:1}:read(c)
 await f.sdk.cancelSubscription(checkout.planKey,f.write)
 expect(f.sent.map(c=>c.functionName)).toEqual(['cancelSubscription'])
 f.io.account=configuration.usdc
 await expect(f.sdk.cancelSubscription(checkout.planKey,f.write)).rejects.toThrow(/permitted/i)
 expect(f.sent).toHaveLength(1)
})
it('forbids arbitration exactly at resolution timeout measured from dispute opening',async()=>{
 const f=fixture(),read=f.io.read,reader=f.io.reader
 f.io.read=async c=>c.functionName==='getEscrow'?{merchant:configuration.manager,customer:configuration.escrow,arbitrator:owner,disputedAt:100,responseWindow:10,resolutionTimeout:100}:read(c)
 f.io.reader=async r=>r.method==='eth_getBlockByNumber'&&r.params?.[0]==='latest'?{timestamp:'0xc8'}:reader(r)
 await expect(f.sdk.resolveDispute(checkout.planKey,'1',hash,f.write)).rejects.toThrow(/deadline/i)
 expect(f.sent).toEqual([])
})
it('subscribes with exact required approval and actual immutable plan comparison', async()=>{
 const f=fixture(); await f.sdk.subscribe({...checkout,customer:owner,externalRef:checkout.planKey,subscriptionKey:checkout.planKey},{responseWindow:86400,resolutionTimeout:172800},f.write)
 expect(f.sent.map(c=>c.functionName)).toEqual(['approve','subscribe'])
 expect(f.sent[0].args[1]).toBe(123456789012345n)
})
it('stale plan cannot produce approval or subscribe prompt',async()=>{
 const f=fixture();f.setPlan({...plan,amount:1n})
 await expect(f.sdk.subscribe({...checkout,customer:owner,externalRef:checkout.planKey,subscriptionKey:checkout.planKey},{responseWindow:86400,resolutionTimeout:172800},f.write)).rejects.toThrow(/plan/i)
 expect(f.sent).toEqual([])
})
it('unprepared or completed checkout cannot charge',async()=>{
 const f=fixture();await expect(f.sdk.subscribe(checkout,{responseWindow:86400,resolutionTimeout:172800},f.write)).rejects.toThrow()
 expect(f.sent).toEqual([])
})
it('rejects stale displayed terms before a finite mandate allowance',async()=>{
 const f=fixture(),read=f.io.read,reader=f.io.reader
 f.io.read=async c=>c.functionName==='getSubscription'?{customer:owner,planKey:checkout.planKey,status:1,amount:BigInt(checkout.amount)}:read(c)
 f.io.reader=async r=>r.method==='eth_getBlockByNumber'&&r.params?.[0]==='latest'?{timestamp:'0x64'}:reader(r)
 f.setPlan({...plan,payout:owner})
 await expect(f.sdk.createMandate(checkout.planKey,{perChargeCap:checkout.amount,totalCap:checkout.amount,expiry:1000},checkout,{responseWindow:86400,resolutionTimeout:172800},f.write)).rejects.toThrow(/plan/i)
 expect(f.sent).toEqual([])
})
it('finite mandate validates explicit budget before approval',async()=>{
 const f=fixture()
 await expect(f.sdk.createMandate(checkout.planKey,{perChargeCap:'1',totalCap:'0',expiry:2000000000},checkout,{responseWindow:86400,resolutionTimeout:172800},f.write)).rejects.toThrow(/budget|cap/i)
 expect(f.sent).toEqual([])
})
