import { ensureInitialInvoice } from './invoices'
import { z } from 'zod'
import type { ChainCheckout, ChainHash } from '../../../shared/chain'
import { requireWorkerOrg } from '../auth/guards'
import { randomToken, sha256 } from '../auth/crypto'
import { conflict, notFound } from '../errors'
import { readBody } from '../http'
import { configuration, snapshot } from './client'
import { intervals, storedPlan, type C } from './plans'
interface CheckoutRow { id:string;org_id:string;subscription_id:string;invoice_id:string;expires_at:string }
interface ContextRow {plan_id:string;customer_id:string;amount:string;interval:keyof typeof intervals;merchant_name:string;product_name:string;plan_name:string;description:string;trial_days:number;escrow_days:number;invoice_status:string;total_amount:string;subscription_status:string}
export async function checkoutContext(c:C, row:CheckoutRow) {
 const data=await c.env.DB.prepare(`SELECT s.plan_id,s.customer_id,s.amount,s."interval",s.status AS subscription_status,o.name AS merchant_name,p.name AS plan_name,pr.name AS product_name,pr.description,p.trial_days,p.escrow_days,i.status AS invoice_status,i.total_amount FROM subscriptions s JOIN organizations o ON o.id=s.org_id JOIN plans p ON p.org_id=s.org_id AND p.id=s.plan_id JOIN products pr ON pr.org_id=p.org_id AND pr.id=p.product_id JOIN invoices i ON i.org_id=s.org_id AND i.subscription_id=s.id AND i.customer_id=s.customer_id WHERE s.org_id=? AND s.id=? AND i.id=? AND o.status='active'`).bind(row.org_id,row.subscription_id,row.invoice_id).first<ContextRow>()
 if(!data)throw notFound('Checkout')
 if(data.amount!==data.total_amount)throw conflict('Invoice amount differs from the immutable subscription price','unsupported_invoice_amount')
 return data
}
export async function checkoutRecord(c:C):Promise<CheckoutRow>{
 const token=c.req.param('token')??''
 if(!/^[a-f0-9]{64}$/.test(token))throw notFound('Checkout')
 const row=await c.env.DB.prepare('SELECT * FROM chain_checkouts WHERE token_hash=? AND expires_at>?').bind(await sha256(token),new Date().toISOString()).first<CheckoutRow>()
 if(!row)throw notFound('Checkout')
 return row
}
export async function checkoutView(c:C,row:CheckoutRow):Promise<ChainCheckout>{
 const d=await checkoutContext(c,row),p=await storedPlan(c,row.org_id,d.plan_id)
 const state=await snapshot(c.env,row.org_id)
 const paid=state.projections.some(v=>v.kind==='invoice'&&v.recordId===row.invoice_id&&v.state==='paid')
 const prepared=await c.env.DB.prepare('SELECT * FROM chain_checkout_preparations WHERE org_id=? AND subscription_id=?').bind(row.org_id,row.subscription_id).first<{external_ref:ChainHash;subscription_key:ChainHash;customer_wallet:`0x${string}`}>()
 const payment=await c.env.DB.prepare('SELECT id FROM payments WHERE org_id=? AND invoice_id=? AND idempotency_key=?').bind(row.org_id,row.invoice_id,`chain:${row.invoice_id}`).first<{id:string}>()
 const escrow=await c.env.DB.prepare('SELECT id FROM escrows WHERE org_id=? AND invoice_id=? AND idempotency_key=?').bind(row.org_id,row.invoice_id,`chain:${row.invoice_id}`).first<{id:string}>()
 return {id:row.id,status:paid?'complete':'open',expiresAt:row.expires_at,merchantName:d.merchant_name,productName:d.product_name,planName:d.plan_name,description:d.description,amount:p.amount,interval:d.interval,intervalSeconds:p.intervalSeconds,trialDays:p.trialSeconds/86400,escrowDays:p.vestDuration/86400,planKey:p.planKey,merchant:p.merchant,payout:p.payout,arbitrator:p.arbitrator,customerMayRefundUnvested:p.customerMayRefundUnvested,subscriptionId:row.subscription_id,invoiceId:row.invoice_id,configuration:await configuration(c.env),...(prepared?{externalRef:prepared.external_ref,subscriptionKey:prepared.subscription_key,customer:prepared.customer_wallet}:{}),...(payment?{paymentId:payment.id}:{}),escrowId:escrow?.id??null}
}
export async function createCheckout(c:C){
 const {orgId}=await requireWorkerOrg(c,'subscriptions:write')
 const input=await readBody(c,z.object({subscriptionId:z.uuid(),invoiceId:z.uuid().optional(),expiresInSeconds:z.number().int().min(60).max(604800).default(86400)}).strict())
 const sub=await c.env.DB.prepare("SELECT plan_id,customer_id FROM subscriptions WHERE org_id=? AND id=? AND status<>'canceled'").bind(orgId,input.subscriptionId).first<{plan_id:string;customer_id:string}>()
 if(!sub)throw notFound('Subscription')
 await storedPlan(c,orgId,sub.plan_id)
 // Existing subscription invoices only; standalone invoices cannot use the manager's fixed charge route.
 const state=await snapshot(c.env,orgId)
 const paid=new Set(state.projections.filter(v=>v.kind==='invoice'&&v.state==='paid').map(v=>v.recordId))
 const invoices=await c.env.DB.prepare('SELECT id,status FROM invoices WHERE org_id=? AND subscription_id=? AND customer_id=? ORDER BY created_at,id').bind(orgId,input.subscriptionId,sub.customer_id).all<{id:string;status:string}>()
 const existingInvoice=invoices.results.find(v=>v.status==='open'&&!paid.has(v.id)&&(!input.invoiceId||v.id===input.invoiceId))
 // Auto-create only the first invoice, never resurrect an already completed initial period.
 const invoice=existingInvoice??(!input.invoiceId&&invoices.results.length===0&&!state.projections.some(v=>v.kind==='subscription'&&v.recordId===input.subscriptionId)?await ensureInitialInvoice(c,orgId,input.subscriptionId,sub.plan_id):null)
 if(!invoice)throw conflict('Create and finalize the next subscription invoice before creating a checkout link','subscription_invoice_required')
 const row:CheckoutRow={id:crypto.randomUUID(),org_id:orgId,subscription_id:input.subscriptionId,invoice_id:invoice.id,expires_at:new Date(Date.now()+input.expiresInSeconds*1000).toISOString()}
 await checkoutContext(c,row)
 const token=randomToken()
 await c.env.DB.prepare('INSERT INTO chain_checkouts(id,token_hash,org_id,subscription_id,invoice_id,expires_at) VALUES (?,?,?,?,?,?)').bind(row.id,await sha256(token),orgId,row.subscription_id,row.invoice_id,row.expires_at).run()
 c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer')
 return c.json({token,url:`/checkout/${token}`,checkout:await checkoutView(c,row)},201)
}
export async function publicCheckout(c:C){c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');return c.json(await checkoutView(c,await checkoutRecord(c)))}
