import type { WorkerBindings } from '../types'
import { conflict } from '../errors'
import { snapshot } from './client'
/** HTTP metadata writes cannot revoke an onchain mandate or destroy binding provenance. */
export async function requireUnboundSubscription(env:WorkerBindings,orgId:string,subscriptionId:string){
 const prepared=await env.DB.prepare('SELECT subscription_id FROM chain_checkout_preparations WHERE org_id=? AND subscription_id=?').bind(orgId,subscriptionId).first()
 if(prepared)throw conflict('Use the contract cancellation action for this chain-bound subscription','chain_action_required')
 const state=await snapshot(env,orgId)
 if(state.bindings.some(b=>b.kind==='subscription'&&b.recordId===subscriptionId)||state.projections.some(p=>p.kind==='subscription'&&p.recordId===subscriptionId))throw conflict('Use the contract cancellation action for this chain-bound subscription','chain_action_required')
}
