import { z } from 'zod'
import type { ChainBinding, ChainHash } from '../../../shared/chain'
import { readBody } from '../http'
import { conflict, forbidden } from '../errors'
import { requireWorkerAuth } from '../auth/guards'
import { address, storedPlan, verifiedWallet, type C } from './plans'
import { checkoutContext, checkoutRecord, checkoutView } from './checkouts'
import { actorKey, chargeKeys, serverReference } from './keys'
import { bind, enabledConfiguration, snapshot } from './client'
export async function prepareCheckout(c:C){
 const auth=requireWorkerAuth(c)
 const input=await readBody(c,z.object({wallet:address}).strict())
 const wallet=await verifiedWallet(c,input.wallet),row=await checkoutRecord(c),d=await checkoutContext(c,row)
 if(!await c.env.DB.prepare("SELECT id FROM wallets WHERE purpose='customer' AND org_id=? AND customer_id=? AND address=? AND chain_id=5042").bind(row.org_id,d.customer_id,wallet).first())throw forbidden('This checkout belongs to a different customer wallet')
 await enabledConfiguration(c.env)
 const p=await storedPlan(c,row.org_id,d.plan_id)
 if(d.subscription_status==='canceled'||!['open','paid'].includes(d.invoice_status))throw conflict('This checkout is not payable')
 const externalRef=serverReference(row.org_id,'subscription',row.subscription_id),subscriptionKey=actorKey(wallet,externalRef)
 await c.env.DB.prepare('INSERT INTO chain_checkout_preparations(org_id,subscription_id,customer_wallet,external_ref,subscription_key) VALUES (?,?,?,?,?) ON CONFLICT(org_id,subscription_id) DO NOTHING').bind(row.org_id,row.subscription_id,wallet,externalRef,subscriptionKey).run()
 const identity=await c.env.DB.prepare('SELECT customer_wallet,subscription_key FROM chain_checkout_preparations WHERE org_id=? AND subscription_id=?').bind(row.org_id,row.subscription_id).first<{customer_wallet:string;subscription_key:ChainHash}>()
 if(identity?.customer_wallet!==wallet||identity.subscription_key!==subscriptionKey)throw forbidden('Subscription is already bound to another wallet')
 const state=await snapshot(c.env,row.org_id)
 const sub=state.projections.find(v=>v.kind==='subscription'&&v.recordId===row.subscription_id)
 const count=sub?.values.chargeCount
 if(count!==undefined && (typeof count!=='string'||!/^\d+$/.test(count)))throw conflict('Invalid verified charge count')
 const chargeNumber=(BigInt(typeof count==='string'?count:'0')+1n).toString()
 try{await c.env.DB.prepare('INSERT INTO chain_charge_preparations(org_id,invoice_id,subscription_id,charge_number) VALUES (?,?,?,?) ON CONFLICT(org_id,invoice_id) DO NOTHING').bind(row.org_id,row.invoice_id,row.subscription_id,chargeNumber).run()}
 catch{throw conflict('The current subscription charge already has an invoice','charge_already_bound')}
 const charge=await c.env.DB.prepare('SELECT charge_number FROM chain_charge_preparations WHERE org_id=? AND invoice_id=?').bind(row.org_id,row.invoice_id).first<{charge_number:string}>()
 if(!charge)throw conflict('Charge identity is unavailable')
 const key=`chain:${row.invoice_id}`
 const paymentId=crypto.randomUUID(),escrowId=crypto.randomUUID()
 const queries=[c.env.DB.prepare("INSERT INTO payments(id,org_id,invoice_id,customer_id,amount,chain_id,idempotency_key,request_hash) SELECT ?,?,?,?,?,5042,?,? WHERE NOT EXISTS (SELECT 1 FROM payments WHERE org_id=? AND invoice_id=? AND status IN ('pending','processing','succeeded'))").bind(paymentId,row.org_id,row.invoice_id,d.customer_id,p.amount,key,key,row.org_id,row.invoice_id),
 c.env.DB.prepare("INSERT INTO audit_logs(id,org_id,actor_user_id,actor_type,action,resource_type,resource_id,metadata,request_id) SELECT ?,?,?,'user','chain.checkout_prepared','payment',?,?,? WHERE changes()=1").bind(crypto.randomUUID(),row.org_id,auth.userId,paymentId,JSON.stringify({invoiceId:row.invoice_id,chargeNumber:charge.charge_number,status:'pending'}),c.get('requestId'))]
 if(p.vestDuration>0)queries.push(c.env.DB.prepare("INSERT INTO escrows(id,org_id,invoice_id,customer_id,amount,release_after_days,chain_id,idempotency_key,request_hash) SELECT ?,?,?,?,?,?,5042,?,? WHERE NOT EXISTS (SELECT 1 FROM escrows WHERE org_id=? AND invoice_id=? AND status IN ('pending_funding','funded','disputed'))").bind(escrowId,row.org_id,row.invoice_id,d.customer_id,p.amount,p.vestDuration/86400,key,key,row.org_id,row.invoice_id))
 await c.env.DB.batch(queries)
 const payment=await c.env.DB.prepare('SELECT id,amount,status FROM payments WHERE org_id=? AND invoice_id=? AND idempotency_key=?').bind(row.org_id,row.invoice_id,key).first<{id:string;amount:string;status:string}>()
 const escrow=p.vestDuration>0?await c.env.DB.prepare('SELECT id,amount FROM escrows WHERE org_id=? AND invoice_id=? AND idempotency_key=?').bind(row.org_id,row.invoice_id,key).first<{id:string;amount:string}>():null
 if(!payment||payment.amount!==p.amount||payment.status!=='pending'||(p.vestDuration>0&&(!escrow||escrow.amount!==p.amount)))throw conflict('A conflicting payment or escrow already exists','payment_identity_conflict')
 const base={orgId:row.org_id,merchant:p.merchant,customer:wallet,planKey:p.planKey,amount:p.amount}
 await bind(c.env,{...base,kind:'subscription',recordId:row.subscription_id,key:subscriptionKey,metadata:{externalRef}})
 const keys=chargeKeys(subscriptionKey,charge.charge_number,p.merchant)
 const chargeBase={...base,subscriptionKey,chargeNumber:charge.charge_number}
 const bindings:ChainBinding[]=[{...chargeBase,kind:'invoice',recordId:row.invoice_id,key:keys.invoiceRef},{...chargeBase,kind:'payment',recordId:payment.id,key:keys.invoiceRef}]
 if(escrow)bindings.push({...chargeBase,kind:'escrow',recordId:escrow.id,key:keys.escrowKey})
 for(const binding of bindings)await bind(c.env,binding)
 c.header('Cache-Control','no-store')
 return c.json(await checkoutView(c,row))
}
