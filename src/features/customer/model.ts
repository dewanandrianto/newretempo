import type { ChainCheckout, ChainConfiguration } from '../../../shared/chain'
import { assertDeployment, baseUnits, configuredReader, escrowAbi, managerAbi, type SubscriptionState } from '@/services/blockchain'

type ContractPauseState = { managerPaused?: boolean | null; escrowPaused?: boolean | null }
/** Unknown pause state is unsafe: both contracts must explicitly report unpaused. */
export function checkoutActionsPaused(configuration: ChainConfiguration): boolean {
 const pause = configuration as ChainConfiguration & ContractPauseState
 return pause.managerPaused !== false || pause.escrowPaused !== false
}
export function checkoutPauseMessage(configuration: ChainConfiguration): string | null {
 if (!configuration.configured) return null
 const pause = configuration as ChainConfiguration & ContractPauseState
 if (pause.managerPaused === true || pause.escrowPaused === true) return 'Verified Arc Testnet contracts are paused; payments and on-chain actions are unavailable.'
 if (pause.managerPaused !== false || pause.escrowPaused !== false) return 'Payments and on-chain actions are disabled because the live contract pause state could not be verified.'
 return null
}

export const checkoutDue=(checkout:ChainCheckout,existing:boolean):bigint=>!existing&&checkout.trialDays>0?0n:baseUnits(checkout.amount)
export async function checkoutSubscription(checkout:ChainCheckout):Promise<SubscriptionState|null> {
 if(!checkout.subscriptionKey)return null
 const c=checkout.configuration,reader=configuredReader(c)
 return await reader.readContract({address:c.manager!,abi:managerAbi,functionName:'getSubscription',args:[checkout.subscriptionKey]}) as SubscriptionState
}
export function checkoutAvailability(checkout:ChainCheckout,now=Date.now()):string|null {
 if(!checkout.configuration.configured)return checkout.configuration.reason??'Payments are disabled: no verified deployment is configured.'
 if(checkout.status==='complete')return 'This checkout is complete according to the verified backend. View your subscription in the portal.'
 if(checkout.status==='expired'||!Number.isFinite(Date.parse(checkout.expiresAt))||Date.parse(checkout.expiresAt)<=now)return 'This link has expired. Ask the merchant for a new checkout link.'
 try{assertDeployment(checkout.configuration);baseUnits(checkout.amount)}catch(e){return e instanceof Error?e.message:'Invalid checkout terms.'}
 const pauseMessage=checkoutPauseMessage(checkout.configuration)
 if(pauseMessage)return pauseMessage
 return null
}
export function assertCheckoutPreparation(displayed:ChainCheckout,prepared:ChainCheckout):void {
 const keys = ['id','amount','planKey','merchant','payout','arbitrator','customerMayRefundUnvested','intervalSeconds','trialDays','escrowDays','subscriptionId','invoiceId'] as const
 const proofs = ['chainId','manager','escrow','managerPaused','escrowPaused','usdc','genesisHash','managerCodeHash','escrowCodeHash','mode'] as const
 if(keys.some(key=>displayed[key]!==prepared[key])||proofs.some(key=>displayed.configuration[key]!==prepared.configuration[key]))throw new Error('Checkout terms or deployment changed. Refresh and review before paying.')
}
export async function checkoutWindows(checkout:ChainCheckout) {
 if(checkout.escrowDays===0)return {responseWindow:0,resolutionTimeout:0}
 const c=checkout.configuration,reader=configuredReader(c)
 const [responseWindow,resolutionTimeout]=await Promise.all([reader.readContract({address:c.escrow!,abi:escrowAbi,functionName:'responseWindow'}),reader.readContract({address:c.escrow!,abi:escrowAbi,functionName:'resolutionTimeout'})])
 return {responseWindow:Number(responseWindow),resolutionTimeout:Number(resolutionTimeout)}
}
