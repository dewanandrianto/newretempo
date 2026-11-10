import { env as testEnv } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { createWorkerApp } from '../src/index'
import { hmac } from '../src/auth/crypto'
import type { WorkerBindings } from '../src/types'
import type { ChainBinding, ChainConfiguration, ChainPlanPreparation, ChainCheckout, ChainProjection, VerifiedChainEvent } from '../../shared/chain'
const env = testEnv as unknown as WorkerBindings
const app = createWorkerApp()
const merchant = '0x1111111111111111111111111111111111111111', buyer = '0x2222222222222222222222222222222222222222', zero = '0x0000000000000000000000000000000000000000'
const config: ChainConfiguration = { chainId:5042002, mode:'local', configured:true, rpcUrl:'http://127.0.0.1:8545', explorerUrl:'', manager:'0x3333333333333333333333333333333333333333', escrow:'0x4444444444444444444444444444444444444444', usdc:'0x3600000000000000000000000000000000000000', usdcDecimals:6, startBlock:'0' }
let org: string, customer: string, plan: string, sub: string, invoice: string, user: string, token: string, bindings: ChainBinding[], projections: ChainProjection[], events: VerifiedChainEvent[], failBindings: boolean, crossTenantSnapshot: boolean
let crossWalletSnapshot = false
// Explicit service fixture, NOT a real chain verifier; DB and HTTP run in workerd.
const service = { fetch: async (request: Request) => {
 const path = new URL(request.url).pathname
 if(path==='/v1/config') return Response.json(config)
 const body = await request.json() as ChainBinding & {orgId:string;wallet:string}
 if(path==='/v1/wallet-snapshot') {
   const account = crossWalletSnapshot ? buyer : body.wallet
   return Response.json({configuration:config,cursor:null,bindings:[],events:[],projections:[{orgId:`wallet:${account}`,kind:'wallet',recordId:account,key:'0x00',state:'updated',values:{account,eventName:'Withdrawn'},blockNumber:'1',transactionHash:'0x01'}]})
 }
 if(path==='/v1/bind') { if(failBindings)return new Response('fixture unavailable',{status:503});bindings.push(body); return Response.json(body) }
 if(path==='/v1/snapshot') return Response.json({configuration:config,cursor:null,bindings:bindings.filter(b=>b.orgId===body.orgId),events,projections:crossTenantSnapshot?projections:projections.filter(p=>p.orgId===body.orgId)})
 return Response.json({configuration:config,cursor:null,processedEvents:0,duplicateEvents:0,busy:false})
} } as Fetcher
async function req(path: string, method='GET', body?: unknown, authenticated=true) {
 return app.request('http://local/api/'+path,{method,headers:{Origin:'https://app.test','X-Requested-With':'retempo','content-type':'application/json', ...(authenticated?{cookie:`retempo_session=${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)}, {...env, CHAIN:service})
}
beforeEach(async()=>{
 org=crypto.randomUUID(); customer=crypto.randomUUID(); plan=crypto.randomUUID(); sub=crypto.randomUUID(); invoice=crypto.randomUUID(); user=crypto.randomUUID(); token=crypto.randomUUID().replaceAll('-','').repeat(2);bindings=[];projections=[];events=[];failBindings=false;crossTenantSnapshot=false;crossWalletSnapshot=false
 await env.DB.prepare("DELETE FROM wallets WHERE purpose='login' AND address=?").bind(merchant).run()
 await env.DB.prepare('INSERT INTO users(id,display_name) VALUES (?,?)').bind(user,'Merchant').run()
 await env.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,auth_method,idle_expires_at,expires_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),user,await hmac(env.SESSION_SECRET,token),'siwe','2099-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z').run()
 await env.DB.prepare("INSERT INTO wallets(id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,5042002,?,'siwe')").bind(crypto.randomUUID(),user,merchant,new Date().toISOString()).run()
 await env.DB.prepare('INSERT INTO organizations(id,name,slug,industry,country,created_by) VALUES (?,?,?,?,?,?)').bind(org,'Real Merchant',org,'Software','US',user).run()
 await env.DB.prepare("INSERT INTO memberships(id,org_id,user_id,role) VALUES (?,?,?,'owner')").bind(crypto.randomUUID(),org,user).run()
 const product=crypto.randomUUID()
 await env.DB.prepare('INSERT INTO products(id,org_id,name) VALUES (?,?,?)').bind(product,org,'Real Product').run()
 await env.DB.prepare('INSERT INTO plans(id,org_id,product_id,name,amount,"interval") VALUES (?,?,?,?,?,?)').bind(plan,org,product,'Real Plan','999999999999999','month').run()
 await env.DB.prepare('INSERT INTO customers(id,org_id,name,email) VALUES (?,?,?,?)').bind(customer,org,'Private Person','private@example.test').run()
 await env.DB.prepare("INSERT INTO wallets(id,purpose,org_id,customer_id,address,chain_id) VALUES (?,'customer',?,?,?,5042002)").bind(crypto.randomUUID(),org,customer,buyer).run()
 await env.DB.prepare('INSERT INTO subscriptions(id,org_id,customer_id,plan_id,amount,"interval") VALUES (?,?,?,?,?,?)').bind(sub,org,customer,plan,'999999999999999','month').run()
 await env.DB.prepare("INSERT INTO invoices(id,org_id,customer_id,subscription_id,number,status,total_amount,line_items,due_at,idempotency_key,request_hash) VALUES (?,?,?,?,?,'open',?,'[]',?,?,?)").bind(invoice,org,customer,sub,'INV-1','999999999999999','2026-12-01T00:00:00.000Z',invoice,'hash').run()
})
const prep = () => req(`orgs/${org}/chain/plans/${plan}/prepare`,'POST',{wallet:merchant,payout:merchant,arbitrator:zero,customerMayRefundUnvested:false})
it('exposes wallet-level proofs only to their verified SIWE owner without attributing them to an organization',async()=>{
 expect((await req('wallet/chain/snapshot','GET',undefined,false)).status).toBe(401)
 expect((await req(`wallet/chain/snapshot?wallet=${buyer}`)).status).toBe(403)
 expect((await req('wallet/chain/snapshot?wallet=invalid')).status).toBe(400)
 const response=await req(`wallet/chain/snapshot?wallet=${merchant}`)
 expect(response.status).toBe(200)
 expect(await response.json()).toMatchObject({bindings:[],projections:[{orgId:`wallet:${merchant}`,kind:'wallet',recordId:merchant}]})
 crossWalletSnapshot=true
 expect((await req(`wallet/chain/snapshot?wallet=${merchant}`)).status).toBe(503)
})
it('refuses plan terms outside actual protocol static amount and grace bounds',async()=>{
 const base={wallet:merchant,payout:merchant,arbitrator:zero,customerMayRefundUnvested:false}
 expect((await req(`orgs/${org}/chain/plans/${plan}/prepare`,'POST',{...base,graceSeconds:2592000})).status).toBe(409)
 for(const amount of ['9999','1000000000000001','9007199254740993']){
  await env.DB.prepare('UPDATE plans SET amount=? WHERE id=?').bind(amount,plan).run()
  expect((await req(`orgs/${org}/chain/plans/${plan}/prepare`,'POST',base)).status).toBe(409)
 }
})
it('prepares immutable server plan terms and registers binding without publishing',async()=>{
 const r=await prep(); expect(r.status,await r.clone().text()).toBe(200)
 const p=await r.json<ChainPlanPreparation>();expect(p.amount).toBe('999999999999999');expect(p.intervalSeconds).toBe(2592000);expect(bindings[0]).toMatchObject({orgId:org,kind:'plan',recordId:plan,key:p.planKey})
 expect(await (await prep()).json()).toEqual(p)
 expect((await env.DB.prepare('SELECT status FROM plans WHERE id=?').bind(plan).first())?.status).toBe('active')
 expect((await req(`orgs/${org}/chain/plans/${plan}/prepare`,'POST',{wallet:buyer,payout:buyer,arbitrator:zero,customerMayRefundUnvested:false})).status).toBe(403)
})
it('enforces RBAC and snapshot tenant isolation and sync throttling',async()=>{
 expect((await req(`orgs/${crypto.randomUUID()}/chain/snapshot`)).status).toBe(404)
 const other=crypto.randomUUID();await env.DB.prepare('INSERT INTO users(id,display_name) VALUES (?,?)').bind(other,'Other owner').run();await env.DB.prepare("INSERT INTO memberships(id,org_id,user_id,role) VALUES (?,?,?,'owner')").bind(crypto.randomUUID(),org,other).run()
 await env.DB.prepare("UPDATE memberships SET role='member' WHERE org_id=? AND user_id=?").bind(org,user).run();expect((await prep()).status).toBe(403)
 crossTenantSnapshot=true
 projections=[{orgId:crypto.randomUUID(),kind:'payment',recordId:'foreign',key:'0x00',state:'succeeded',values:{},blockNumber:'1',transactionHash:null}]
 expect((await req(`orgs/${org}/chain/snapshot`)).status).toBe(503)
})
it('rejects legacy HTTP cancellation and deletion of chain-bound active subscriptions',async()=>{
 bindings=[{orgId:org,kind:'subscription',recordId:sub,key:'0x01',merchant,customer:buyer,planKey:'0x02'}]
 projections=[{orgId:org,kind:'subscription',recordId:sub,key:'0x01',state:'active',values:{amount:'700000',nextChargeAt:'2026-12-01T00:00:00.000Z'},blockNumber:'1',transactionHash:null}]
 expect((await req(`orgs/${org}/subscriptions/${sub}`,'PATCH',{status:'canceled'})).status).toBe(409)
 expect((await req(`orgs/${org}/subscriptions/${sub}`,'PATCH',{cancelAtPeriodEnd:true})).status).toBe(409)
 expect((await req(`orgs/${org}/subscriptions/${sub}`,'DELETE')).status).toBe(409)
 expect(await (await req(`orgs/${org}/subscriptions/${sub}`)).json()).toMatchObject({status:'active',amount:'700000',currentPeriodEnd:'2026-12-01T00:00:00.000Z'})
 expect((await env.DB.prepare('SELECT status FROM subscriptions WHERE id=?').bind(sub).first())?.status).toBe('incomplete')
 await env.DB.prepare('INSERT INTO chain_checkout_preparations(org_id,subscription_id,customer_wallet,external_ref,subscription_key) VALUES (?,?,?,?,?)').bind(org,sub,buyer,'0x03','0x01').run()
 await expect(env.DB.prepare("UPDATE subscriptions SET status='canceled',canceled_at=? WHERE id=?").bind(new Date().toISOString(),sub).run()).rejects.toThrow()
})
it('overlays private verified payment state without modifying guarded base records',async()=>{
 const payment=crypto.randomUUID()
 await env.DB.prepare('INSERT INTO payments(id,org_id,invoice_id,customer_id,amount,chain_id,idempotency_key,request_hash) VALUES (?,?,?,?,?,5042002,?,?)').bind(payment,org,invoice,customer,'999999999999999',payment,payment).run()
 projections=[{orgId:org,kind:'payment',recordId:payment,key:'0x00',state:'paid',values:{},blockNumber:'1',transactionHash:('0x'+'ab'.repeat(32)) as `0x${string}`}]
 const response=await req(`orgs/${org}/payments`);expect(await response.json()).toEqual(expect.arrayContaining([expect.objectContaining({id:payment,status:'succeeded',amount:'999999999999999'})]))
 expect((await env.DB.prepare('SELECT status FROM payments WHERE id=?').bind(payment).first())?.status).toBe('pending')
 projections=[];expect(await (await req(`orgs/${org}/payments/${payment}`)).json()).toMatchObject({status:'pending',txHash:null})
})
it('returns only verified-wallet-owned portal bindings, projections and events',async()=>{
 await prep()
 expect(await (await req('customer/chain/snapshot')).json()).toMatchObject({bindings:[],projections:[],events:[]})
 expect((await req('customer/chain/snapshot','GET',undefined,false)).status).toBe(401)
 const link=await (await req(`orgs/${org}/chain/checkouts`,'POST',{subscriptionId:sub,invoiceId:invoice})).json<{token:string}>()
 await env.DB.prepare("DELETE FROM wallets WHERE purpose='login' AND address=?").bind(buyer).run()
 await env.DB.prepare("INSERT INTO wallets(id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,5042002,?,'siwe')").bind(crypto.randomUUID(),user,buyer,new Date().toISOString()).run()
 await req(`public/checkouts/${link.token}/prepare`,'POST',{wallet:buyer})
 const foreign='0x6666666666666666666666666666666666666666'
 bindings.push({orgId:org,kind:'subscription',recordId:'foreign-sub',key:'0x99',merchant,customer:foreign,planKey:bindings[0].key})
 projections.push({orgId:org,kind:'subscription',recordId:'foreign-sub',key:'0x99',state:'active',values:{customer:foreign},blockNumber:'1',transactionHash:null})
 events.push({id:'foreign-event',chainId:5042002,address:config.manager!,blockNumber:'1',blockHash:'0x01',transactionHash:'0x02',transactionIndex:0,logIndex:0,timestamp:new Date().toISOString(),name:'SubscriptionCreated',args:{customer:foreign,merchant:buyer,planKey:bindings[0].key,subKey:'0x99'}})
 const result=await (await req('customer/chain/snapshot')).json<{bindings:ChainBinding[];projections:ChainProjection[];events:VerifiedChainEvent[]}>()
 expect(result.projections.some(p=>p.recordId==='foreign-sub')).toBe(false);expect(result.events.some(e=>e.id==='foreign-event')).toBe(false)
 expect(result.bindings.some(b=>b.kind==='subscription'&&b.customer===buyer)).toBe(true)
 expect(result.bindings.every(b=>b.customer===buyer||b.kind==='plan')).toBe(true)
})
it('rejects caller-supplied sync logs and endpoints',async()=>{
 expect((await req('chain/sync','POST',{logs:[],rpcUrl:'https://attacker.test',status:'paid'})).status).toBe(422)
})
it('creates an exact initial subscription invoice when the merchant requests checkout without one',async()=>{
 await prep()
 // Existing seed invoice is unrelated to the initial billing-period identity; use a fresh subscription.
 await env.DB.prepare("UPDATE subscriptions SET status='canceled',canceled_at=? WHERE id=?").bind(new Date().toISOString(),sub).run()
 sub=crypto.randomUUID()
 await env.DB.prepare('INSERT INTO subscriptions(id,org_id,customer_id,plan_id,amount,"interval") VALUES (?,?,?,?,?,?)').bind(sub,org,customer,plan,'999999999999999','month').run()
 const r=await req(`orgs/${org}/chain/checkouts`,'POST',{subscriptionId:sub});expect(r.status,await r.clone().text()).toBe(201)
 const link=await r.json<{checkout:ChainCheckout}>();expect(link.checkout.invoiceId).toBeTruthy();expect(link.checkout.amount).toBe('999999999999999')
 const again=await (await req(`orgs/${org}/chain/checkouts`,'POST',{subscriptionId:sub})).json<{checkout:ChainCheckout}>();expect(again.checkout.invoiceId).toBe(link.checkout.invoiceId)
})
it('throttles authenticated sync calls and rejects missing deployment preparation',async()=>{
 for(let i=0;i<5;i++)expect((await req('chain/sync','POST',{})).status).toBe(200)
 expect((await req('chain/sync','POST',{})).status).toBe(429)
 const r=await app.request(`http://local/api/orgs/${org}/chain/plans/${plan}/prepare`,{method:'POST',headers:{Origin:'https://app.test','X-Requested-With':'retempo','content-type':'application/json',cookie:`retempo_session=${token}`},body:JSON.stringify({wallet:merchant,payout:merchant,arbitrator:zero,customerMayRefundUnvested:false})},env)
 expect(r.status).toBe(503)
})
it('binds stable escrow identities under concurrent preparation without funding base records',async()=>{
 await env.DB.prepare('UPDATE plans SET escrow_days=7 WHERE id=?').bind(plan).run()
 const preparation=await req(`orgs/${org}/chain/plans/${plan}/prepare`,'POST',{wallet:merchant,payout:merchant,arbitrator:'0x5555555555555555555555555555555555555555',customerMayRefundUnvested:true})
 expect(preparation.status).toBe(200)
 const link=await (await req(`orgs/${org}/chain/checkouts`,'POST',{subscriptionId:sub,invoiceId:invoice})).json<{token:string}>()
 await env.DB.prepare("DELETE FROM wallets WHERE purpose='login' AND address=?").bind(buyer).run()
 await env.DB.prepare("INSERT INTO wallets(id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,5042002,?,'siwe')").bind(crypto.randomUUID(),user,buyer,new Date().toISOString()).run()
 const responses=await Promise.all(Array.from({length:4},()=>req(`public/checkouts/${link.token}/prepare`,'POST',{wallet:buyer})))
 expect(responses.map(r=>r.status)).toEqual([200,200,200,200])
 const views=await Promise.all(responses.map(r=>r.json<ChainCheckout>()))
 expect(new Set(views.map(v=>v.paymentId)).size).toBe(1);expect(new Set(views.map(v=>v.escrowId)).size).toBe(1)
 expect((await env.DB.prepare('SELECT status FROM escrows WHERE id=?').bind(views[0].escrowId).first())?.status).toBe('pending_funding')
 expect(bindings.some(b=>b.kind==='escrow'&&b.recordId===views[0].escrowId)).toBe(true)
})
it('rejects mismatched invoice totals and standalone invoice context',async()=>{
 await prep()
 const other=crypto.randomUUID()
 await env.DB.prepare("INSERT INTO invoices(id,org_id,customer_id,number,status,total_amount,line_items,due_at,idempotency_key,request_hash) VALUES (?,?,?,'INV-OTHER','open','1','[]','2026-12-01T00:00:00.000Z',?,?)").bind(other,org,customer,other,other).run()
 expect((await req(`orgs/${org}/chain/checkouts`,'POST',{subscriptionId:sub,invoiceId:other})).status).toBe(409)
})
it('keeps retry identities and one pending-record audit when private binding fails',async()=>{
 await prep()
 const link=await (await req(`orgs/${org}/chain/checkouts`,'POST',{subscriptionId:sub,invoiceId:invoice})).json<{token:string}>()
 await env.DB.prepare("DELETE FROM wallets WHERE purpose='login' AND address=?").bind(buyer).run()
 await env.DB.prepare("INSERT INTO wallets(id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,5042002,?,'siwe')").bind(crypto.randomUUID(),user,buyer,new Date().toISOString()).run()
 failBindings=true
 expect((await req(`public/checkouts/${link.token}/prepare`,'POST',{wallet:buyer})).status).toBe(503)
 const pending=await env.DB.prepare('SELECT id FROM payments WHERE org_id=? AND invoice_id=?').bind(org,invoice).first<{id:string}>()
 failBindings=false
 const r=await req(`public/checkouts/${link.token}/prepare`,'POST',{wallet:buyer});expect(r.status).toBe(200);expect(await r.json()).toMatchObject({paymentId:pending?.id,status:'open'})
 expect((await env.DB.prepare("SELECT count(*) AS n FROM audit_logs WHERE org_id=? AND action='chain.checkout_prepared'").bind(org).first())?.n).toBe(1)
})
it('prepares stable payment identities only for the exact verified customer wallet',async()=>{
 await prep()
 const link=await (await req(`orgs/${org}/chain/checkouts`,'POST',{subscriptionId:sub,invoiceId:invoice})).json<{token:string}>()
 const path=`public/checkouts/${link.token}/prepare`
 expect((await req(path,'POST',{wallet:buyer},false)).status).toBe(401)
 expect((await req(path,'POST',{wallet:buyer})).status).toBe(403)
 expect((await req(path,'POST',{wallet:merchant})).status).toBe(403)
 await env.DB.prepare("DELETE FROM wallets WHERE purpose='login' AND address=?").bind(buyer).run()
 await env.DB.prepare("INSERT INTO wallets(id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,5042002,?,'siwe')").bind(crypto.randomUUID(),user,buyer,new Date().toISOString()).run()
 const r=await req(path,'POST',{wallet:buyer});expect(r.status,await r.clone().text()).toBe(200)
 const first=await r.json<ChainCheckout>();expect(first.paymentId).toBeTruthy();expect(first.customer).toBe(buyer);expect(first.subscriptionKey).toMatch(/^0x[0-9a-f]{64}$/)
 const retry=await req(path,'POST',{wallet:buyer});expect(await retry.json()).toEqual(first)
 expect(bindings.filter(b=>b.kind==='payment').at(-1)).toMatchObject({recordId:first.paymentId,chargeNumber:'1',amount:'999999999999999'})
 expect((await env.DB.prepare('SELECT status FROM payments WHERE id=?').bind(first.paymentId).first())?.status).toBe('pending')
 expect((await req(path,'POST',{wallet:buyer,status:'succeeded',txHash:'0x'+'ab'.repeat(32)})).status).toBe(422)
})
it('issues hashed expiring capability, rejects guessed ids and keeps checkout private',async()=>{
 await prep()
 const r=await req(`orgs/${org}/chain/checkouts`,'POST',{subscriptionId:sub,invoiceId:invoice,expiresInSeconds:60})
 expect(r.status,await r.clone().text()).toBe(201)
 const link=await r.json<{token:string;url:string;checkout:ChainCheckout}>()
 expect(link.token).toMatch(/^[a-f0-9]{64}$/)
 const view=await req(`public/checkouts/${link.token}`,'GET',undefined,false)
 expect(view.status).toBe(200);expect(await view.clone().text()).not.toContain('private@example.test');expect(await view.clone().text()).not.toContain('Private Person')
 expect(await view.json()).toMatchObject({amount:'999999999999999',subscriptionId:sub,invoiceId:invoice})
 const saved=await env.DB.prepare('SELECT token_hash FROM chain_checkouts WHERE id=?').bind(link.checkout.id).first<{token_hash:string}>();expect(saved?.token_hash).not.toBe(link.token)
 expect((await req(`public/invoices/${invoice}`,'GET',undefined,false)).status).toBe(404)
 await env.DB.prepare('UPDATE chain_checkouts SET expires_at=? WHERE id=?').bind('2020-01-01T00:00:00.000Z',link.checkout.id).run()
 expect((await req(`public/checkouts/${link.token}`,'GET',undefined,false)).status).toBe(404)
})

