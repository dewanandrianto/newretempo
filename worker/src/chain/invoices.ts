import type { C } from './plans'
import { requireWorkerAuth } from '../auth/guards'
import { storedPlan } from './plans'
import { conflict } from '../errors'
export async function ensureInitialInvoice(c:C,orgId:string,subscriptionId:string,planId:string):Promise<{id:string}>{
 const auth=requireWorkerAuth(c),p=await storedPlan(c,orgId,planId),key=`chain:initial:${subscriptionId}`,id=crypto.randomUUID(),now=new Date().toISOString()
 const existing=()=>c.env.DB.prepare('SELECT id FROM invoices WHERE org_id=? AND idempotency_key=?').bind(orgId,key).first<{id:string}>()
 const prior=await existing();if(prior)return prior
 // Only the initial period can be prepared without the merchant selecting an existing invoice.
 if(await c.env.DB.prepare('SELECT invoice_id FROM chain_charge_preparations WHERE org_id=? AND subscription_id=?').bind(orgId,subscriptionId).first())throw conflict('Select the invoice for the next subscription period','invoice_required')
 await c.env.DB.batch([
  c.env.DB.prepare('UPDATE organizations SET invoice_counter=invoice_counter+1 WHERE id=? AND NOT EXISTS (SELECT 1 FROM invoices WHERE org_id=? AND idempotency_key=?)').bind(orgId,orgId,key),
  c.env.DB.prepare(`INSERT INTO invoices(id,org_id,customer_id,subscription_id,number,status,total_amount,line_items,period_start,issued_at,due_at,idempotency_key,request_hash) SELECT ?,s.org_id,s.customer_id,s.id,printf('INV-%s-%06d',substr(?,1,4),o.invoice_counter),'open',?,?,s.created_at,?,?,?,? FROM subscriptions s JOIN organizations o ON o.id=s.org_id WHERE s.org_id=? AND s.id=? AND s.status='incomplete' AND NOT EXISTS (SELECT 1 FROM invoices WHERE org_id=? AND idempotency_key=?)`).bind(id,now,p.amount,JSON.stringify([{description:'Initial subscription period',quantity:1,unitAmount:p.amount}]),now,now,key,key,orgId,subscriptionId,orgId,key),
  c.env.DB.prepare("INSERT INTO audit_logs(id,org_id,actor_user_id,actor_type,action,resource_type,resource_id,metadata,request_id) SELECT ?,?,?,'user','invoice.created','invoice',?,'{}',? WHERE changes()=1").bind(crypto.randomUUID(),orgId,auth.userId,id,c.get('requestId')),
 ])
 const row=await existing();if(!row)throw conflict('An open subscription invoice must be selected','invoice_required')
 return row
}
