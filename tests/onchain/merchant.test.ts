import { expect, it } from 'vitest'
import { assertPreparedMerchant, merchantEscrowPermissions } from '../../src/features/onchain/merchantModel'
import { configuration } from './fixtures'
import { zeroAddress } from 'viem'
it('refuses a preparation from a different RPC world before publishing',()=>{
 const p={configuration:{...configuration,genesisHash:`0x${'aa'.repeat(32)}` as const},merchant:zeroAddress,planId:'plan'}
 expect(()=>assertPreparedMerchant(p,configuration,zeroAddress,'plan')).toThrow(/deployment/i)
})
it('gates escrow controls by wallet, dispute state and exclusive deadline',()=>{
 const e={merchant:configuration.manager!,arbitrator:configuration.escrow!,status:2,dispute:1,merchantResponded:false,disputedAt:100,responseWindow:10,resolutionTimeout:20}
 expect(merchantEscrowPermissions(e,configuration.manager!,109)).toMatchObject({respond:true,claim:true,refund:true,resolve:false,expire:false})
 expect(merchantEscrowPermissions(e,configuration.manager!,110).respond).toBe(true)
 expect(merchantEscrowPermissions(e,configuration.manager!,111).respond).toBe(false)
 expect(merchantEscrowPermissions(e,configuration.escrow!,119).resolve).toBe(true)
 expect(merchantEscrowPermissions(e,configuration.escrow!,120)).toMatchObject({resolve:false,expire:true})
 expect(merchantEscrowPermissions({...e,dispute:0},zeroAddress,101)).toMatchObject({claim:false,refund:false,respond:false,resolve:false})
})
