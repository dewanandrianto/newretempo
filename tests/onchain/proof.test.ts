import { expect, it } from 'vitest'
import { projectionProves, transactionId } from '../../src/features/onchain/proof'
import { configuration, checkout } from './fixtures'
import type { ChainSnapshot } from '../../shared/chain'
const hash=`0x${'aa'.repeat(32)}` as const
it('requires exact target and successful verified payment event, not just a receipt or pending projection',()=>{
 const snapshot:ChainSnapshot={configuration,cursor:null,bindings:[],events:[],projections:[{orgId:'org',kind:'payment',recordId:'payment',key:checkout.planKey,state:'pending',values:{},blockNumber:'1',transactionHash:hash}]}
 const target={kind:'payment' as const,key:checkout.planKey,states:['succeeded'],eventNames:['PaymentExecuted']}
 expect(projectionProves(snapshot,hash,target)).toBe(false)
 snapshot.projections[0].state='succeeded'
 expect(projectionProves(snapshot,hash,target)).toBe(false)
 snapshot.events=[{id:'event',chainId:5042,address:configuration.manager!,blockNumber:'1',blockHash:hash,transactionHash:hash,transactionIndex:0,logIndex:0,timestamp:'2026-01-01T00:00:00Z',name:'PaymentExecuted',args:{}}]
 expect(projectionProves(snapshot,hash,target)).toBe(true)
 expect(projectionProves(snapshot,hash,{...target,key:hash})).toBe(false)
 expect(projectionProves({...snapshot,configuration:{...configuration,genesisHash:hash}},hash,target,configuration)).toBe(false)
})
it('journals safe public identity without raw capability tokens',()=>{
 const id=transactionId(configuration,'0x3333333333333333333333333333333333333333','subscribe',checkout.planKey)
 expect(id).not.toContain('token');expect(id).toMatch(/^0x[\da-f]{64}$/)
 expect(transactionId({...configuration,genesisHash:hash},'0x3333333333333333333333333333333333333333','subscribe',checkout.planKey)).not.toBe(id)
})
