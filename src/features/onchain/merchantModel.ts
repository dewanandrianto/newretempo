import type { ChainConfiguration } from '../../../shared/chain'
import type { EscrowState } from '@/services/blockchain/client'
import type { Address } from 'viem'
export function merchantEscrowPermissions(e:Pick<EscrowState,'merchant'|'arbitrator'|'status'|'dispute'|'merchantResponded'|'disputedAt'|'responseWindow'|'resolutionTimeout'>,wallet:string|undefined,now:number) {
 const merchant=Boolean(wallet&&wallet.toLowerCase()===e.merchant.toLowerCase()),open=e.status===2&&e.dispute===1
 return {claim:merchant&&e.status===2,refund:merchant&&e.status===2,respond:merchant&&open&&!e.merchantResponded&&now<=e.disputedAt+e.responseWindow,resolve:Boolean(wallet&&wallet.toLowerCase()===e.arbitrator.toLowerCase()&&open&&now<e.disputedAt+e.resolutionTimeout&&(e.merchantResponded||now>e.disputedAt+e.responseWindow)),expire:open&&now>=e.disputedAt+e.resolutionTimeout}
}
export function assertPreparedMerchant(prepared:{configuration:ChainConfiguration;merchant:Address;planId:string},configuration:ChainConfiguration,wallet:Address,planId:string):void {
 if(prepared.planId!==planId||prepared.merchant.toLowerCase()!==wallet.toLowerCase())throw new Error('Prepared merchant or plan identity changed. Review again.')
 if((['chainId','genesisHash','manager','escrow','managerCodeHash','escrowCodeHash'] as const).some(k=>String(prepared.configuration[k]).toLowerCase()!==String(configuration[k]).toLowerCase()))throw new Error('Prepared deployment changed. Reload configuration before publishing.')
}
