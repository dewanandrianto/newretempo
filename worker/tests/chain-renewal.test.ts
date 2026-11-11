import { env as testEnv } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { createWorkerApp } from '../src/index'
import { hmac } from '../src/auth/crypto'
import type { WorkerBindings } from '../src/types'
import type { ChainBinding, ChainConfiguration, ChainProjection } from '../../shared/chain'

const env = testEnv as unknown as WorkerBindings
const app = createWorkerApp()
const merchant = '0x1111111111111111111111111111111111111111'
const zero = '0x0000000000000000000000000000000000000000'
const config: ChainConfiguration = { chainId:5042002, mode:'local', configured:true, rpcUrl:'http://127.0.0.1:8545', explorerUrl:'', manager:'0x3333333333333333333333333333333333333333', escrow:'0x4444444444444444444444444444444444444444', managerPaused:false, escrowPaused:false, usdc:'0x3600000000000000000000000000000000000000', usdcDecimals:6, startBlock:'0' }
let org: string, customer: string, plan: string, sub: string, invoice: string, token: string
let bindings: ChainBinding[], projections: ChainProjection[]
// Only the private service is a fixture; HTTP, migrations and guarded DB run in workerd/D1.
const service = { fetch: async (request: Request) => {
 const path = new URL(request.url).pathname
 if(path==='/v1/config') return Response.json(config)
 const body = await request.json() as ChainBinding & {orgId:string}
 if(path==='/v1/bind') { bindings.push(body); return Response.json(body) }
 if(path==='/v1/snapshot') return Response.json({configuration:config,cursor:null,bindings:bindings.filter(b=>b.orgId===body.orgId),events:[],projections:projections.filter(p=>p.orgId===body.orgId)})
 return new Response('Unexpected fixture request',{status:500})
} } as Fetcher
async function req(path: string, method='POST', body?: unknown) {
 return app.request(`http://local/api/orgs/${org}/${path}`,{method,headers:{Origin:'https://app.test','X-Requested-With':'retempo','content-type':'application/json',cookie:`retempo_session=${token}`,'Idempotency-Key':crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body)}, {...env, CHAIN:service})
}
beforeEach(async()=>{
 org=crypto.randomUUID(); customer=crypto.randomUUID(); plan=crypto.randomUUID(); sub=crypto.randomUUID(); invoice=crypto.randomUUID(); const user=crypto.randomUUID(); token=crypto.randomUUID().replaceAll('-','').repeat(2);bindings=[];projections=[]
 await env.DB.prepare("DELETE FROM wallets WHERE purpose='login' AND address=?").bind(merchant).run()
 await env.DB.prepare('INSERT INTO users(id,display_name) VALUES (?,?)').bind(user,'Merchant').run()
 await env.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,auth_method,idle_expires_at,expires_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),user,await hmac(env.SESSION_SECRET,token),'siwe','2099-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z').run()
 await env.DB.prepare("INSERT INTO wallets(id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,5042002,?,'siwe')").bind(crypto.randomUUID(),user,merchant,new Date().toISOString()).run()
 await env.DB.prepare('INSERT INTO organizations(id,name,slug,industry,country,created_by) VALUES (?,?,?,?,?,?)').bind(org,'Merchant',org,'Software','US',user).run()
 await env.DB.prepare("INSERT INTO memberships(id,org_id,user_id,role) VALUES (?,?,?,'owner')").bind(crypto.randomUUID(),org,user).run()
 const product=crypto.randomUUID()
 await env.DB.prepare('INSERT INTO products(id,org_id,name) VALUES (?,?,?)').bind(product,org,'Product').run()
 await env.DB.prepare('INSERT INTO plans(id,org_id,product_id,name,amount,"interval") VALUES (?,?,?,?,?,?)').bind(plan,org,product,'Plan','999999999999999','month').run()
 await env.DB.prepare('INSERT INTO customers(id,org_id,name,email) VALUES (?,?,?,?)').bind(customer,org,'Buyer','buyer@example.test').run()
 await env.DB.prepare('INSERT INTO subscriptions(id,org_id,customer_id,plan_id,amount,"interval") VALUES (?,?,?,?,?,?)').bind(sub,org,customer,plan,'999999999999999','month').run()
 await env.DB.prepare("INSERT INTO invoices(id,org_id,customer_id,subscription_id,number,status,total_amount,line_items,due_at,idempotency_key,request_hash) VALUES (?,?,?,?,?,'open',?,'[]',?,?,?)").bind(invoice,org,customer,sub,'INV-OLD','999999999999999','2026-12-01T00:00:00.000Z',`chain:initial:${sub}`,'hash').run()
 expect((await req(`chain/plans/${plan}/prepare`,'POST',{wallet:merchant,payout:merchant,arbitrator:zero,customerMayRefundUnvested:false})).status).toBe(200)
 projections=[{orgId:org,kind:'invoice',recordId:invoice,key:'0x01',state:'paid',values:{},blockNumber:'1',transactionHash:null}]
})
it('never creates a checkout for an explicitly selected projected-paid base-open invoice',async()=>{
 const r=await req('chain/checkouts','POST',{subscriptionId:sub,invoiceId:invoice})
 expect(r.status,await r.clone().text()).toBe(409)
 expect(await r.text()).toContain('Create and finalize the next subscription invoice')
 expect((await env.DB.prepare('SELECT status FROM invoices WHERE id=?').bind(invoice).first())?.status).toBe('open')
 expect((await env.DB.prepare('SELECT count(*) AS n FROM chain_checkouts WHERE org_id=?').bind(org).first())?.n).toBe(0)
})
it('requires a new finalized period invoice and skips the old projected-paid invoice when selecting checkout',async()=>{
 // The initial auto-invoice idempotency record must never resurrect a completed period.
 const missing=await req('chain/checkouts','POST',{subscriptionId:sub})
 expect(missing.status,await missing.clone().text()).toBe(409)
 expect(await missing.text()).toContain('Create and finalize the next subscription invoice')
 const periodStart='2026-12-01T13:14:15.123Z'
 projections.push({orgId:org,kind:'subscription',recordId:sub,key:'0x02',state:'active',values:{nextChargeAt:periodStart,chargeCount:'1'},blockNumber:'1',transactionHash:null})
 const created=await req('invoices','POST',{customerId:customer,subscriptionId:sub,periodStart,lineItems:[{description:'Next subscription period',quantity:1,unitAmount:'999999999999999'}],dueAt:'2026-12-14T23:59:59.000Z'})
 expect(created.status,await created.clone().text()).toBe(201)
 const next=await created.json<{id:string;status:string;subscriptionId:string}>()
 expect(next).toMatchObject({status:'draft',subscriptionId:sub})
 expect((await env.DB.prepare('SELECT period_start FROM invoices WHERE id=?').bind(next.id).first())?.period_start).toBe(periodStart)
 expect((await req('chain/checkouts','POST',{subscriptionId:sub})).status).toBe(409)
 const finalized=await req(`invoices/${next.id}/finalize`)
 expect(finalized.status,await finalized.clone().text()).toBe(200)
 expect(await finalized.json()).toMatchObject({id:next.id,status:'open'})
 expect((await env.DB.prepare('SELECT period_start FROM invoices WHERE id=?').bind(next.id).first())?.period_start).toBe(periodStart)
 const checkout=await req('chain/checkouts','POST',{subscriptionId:sub})
 expect(checkout.status,await checkout.clone().text()).toBe(201)
 expect(await checkout.json()).toMatchObject({checkout:{invoiceId:next.id,status:'open'}})
 const explicit=await req('chain/checkouts','POST',{subscriptionId:sub,invoiceId:next.id})
 expect(explicit.status,await explicit.clone().text()).toBe(201)
 expect(await explicit.json()).toMatchObject({checkout:{invoiceId:next.id,status:'open'}})
 expect((await env.DB.prepare('SELECT status FROM invoices WHERE id=?').bind(invoice).first())?.status).toBe('open')
 expect((await env.DB.prepare('SELECT count(*) AS n FROM payments WHERE org_id=?').bind(org).first())?.n).toBe(0)
 expect((await env.DB.prepare('SELECT count(*) AS n FROM chain_charge_preparations WHERE org_id=?').bind(org).first())?.n).toBe(0)
})
