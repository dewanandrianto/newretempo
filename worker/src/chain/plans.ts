import type { Context } from 'hono'
import { z } from 'zod'
import type { ChainAddress, ChainPlanPreparation } from '../../../shared/chain'
import type { WorkerContext } from '../types'
import { requireWorkerAuth, requireWorkerOrg } from '../auth/guards'
import { forbidden, conflict, notFound } from '../errors'
import { readBody } from '../http'
import { bind, enabledConfiguration } from './client'
import { actorKey, serverReference } from './keys'
export type C = Context<WorkerContext>
export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => v.toLowerCase() as ChainAddress)
export const zero = '0x0000000000000000000000000000000000000000'
export const intervals = {week:604800,month:2592000,year:31536000} as const
export async function verifiedWallet(c: C, requested?: string): Promise<ChainAddress> {
 const auth = requireWorkerAuth(c)
 const wallets = await c.env.DB.prepare("SELECT address FROM wallets WHERE user_id=? AND purpose='login' AND verified_at IS NOT NULL AND verification_method='siwe' AND chain_id=5042002 ORDER BY address").bind(auth.userId).all<{address:ChainAddress}>()
 const wallet = requested ? wallets.results.find(w => w.address === requested) : wallets.results.length===1 ? wallets.results[0] : undefined
 if (!wallet) throw forbidden('A verified wallet owned by this session is required')
 return wallet.address
}
export async function storedPlan(c: C, orgId: string, planId: string): Promise<ChainPlanPreparation> {
 const row = await c.env.DB.prepare('SELECT preparation FROM chain_plan_terms WHERE org_id=? AND plan_id=?').bind(orgId,planId).first<{preparation:string}>()
 if(!row)throw conflict('Prepare and publish the plan before creating checkout','plan_not_prepared')
 return JSON.parse(row.preparation) as ChainPlanPreparation
}
export async function preparePlan(c: C) {
 const {orgId} = await requireWorkerOrg(c,'catalog:write')
 const input = await readBody(c,z.object({wallet:address,payout:address,arbitrator:address,customerMayRefundUnvested:z.boolean(),graceSeconds:z.number().int().min(0).max(31536000).default(0)}).strict())
 const merchant = await verifiedWallet(c,input.wallet), config = await enabledConfiguration(c.env), planId=c.req.param('planId')!
 const plan=await c.env.DB.prepare('SELECT * FROM plans WHERE org_id=? AND id=? AND status=\'active\'').bind(orgId,planId).first<{amount:string;interval:keyof typeof intervals;trial_days:number;escrow_days:number}>()
 if(!plan)throw notFound('Plan')
 if(BigInt(plan.amount)<10000n||BigInt(plan.amount)>1000000000000000n||input.graceSeconds>=intervals[plan.interval])throw conflict('Plan amount or grace exceeds protocol bounds','unsupported_plan_terms')
 if(input.payout===zero || (plan.escrow_days>0 && (input.arbitrator===zero || input.arbitrator===merchant)))throw conflict('Invalid payout or escrow arbitrator')
 if(plan.escrow_days===0 && (input.arbitrator!==zero || input.customerMayRefundUnvested))throw conflict('Direct plans do not have escrow refund terms')
 const externalRef=serverReference(orgId,'plan',planId)
 const preparation:ChainPlanPreparation={configuration:config,planId,externalRef,planKey:actorKey(merchant,externalRef),merchant,payout:input.payout,amount:plan.amount,intervalSeconds:intervals[plan.interval],trialSeconds:plan.trial_days*86400,graceSeconds:input.graceSeconds,vestDuration:plan.escrow_days*86400,arbitrator:input.arbitrator,customerMayRefundUnvested:input.customerMayRefundUnvested}
 await c.env.DB.prepare('INSERT INTO chain_plan_terms(org_id,plan_id,preparation) VALUES (?,?,?) ON CONFLICT(org_id,plan_id) DO NOTHING').bind(orgId,planId,JSON.stringify(preparation)).run()
 const stored=await storedPlan(c,orgId,planId)
 if(JSON.stringify({...stored,configuration:config})!==JSON.stringify(preparation))throw conflict('Published plan identities and terms are immutable; create a new plan','immutable_plan')
 await bind(c.env,{orgId,kind:'plan',recordId:planId,key:stored.planKey,merchant,amount:stored.amount,metadata:{externalRef,payout:stored.payout,arbitrator:stored.arbitrator,customerMayRefundUnvested:stored.customerMayRefundUnvested,interval:String(stored.intervalSeconds),trial:String(stored.trialSeconds),grace:String(stored.graceSeconds),vestDuration:String(stored.vestDuration)}})
 return c.json({...stored,configuration:config})
}
