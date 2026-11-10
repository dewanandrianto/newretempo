import { env } from 'cloudflare:test'
import { expect, it } from 'vitest'
import { createWorkerApp } from '../src/index'
import { hmac, randomToken } from '../src/auth/crypto'
import { disabledConfiguration } from '../src/chain/client'
import type { WorkerBindings } from '../src/types'
const bindings=env as unknown as WorkerBindings
async function fixture(){
 const user=crypto.randomUUID(),org=crypto.randomUUID(),token=randomToken(),wallet='0x'+randomToken(20),walletId=crypto.randomUUID()
 await bindings.DB.batch([
  bindings.DB.prepare('INSERT INTO users(id,display_name) VALUES (?,?)').bind(user,'History test'),
  bindings.DB.prepare("INSERT INTO sessions(id,user_id,token_hash,auth_method,idle_expires_at,expires_at) VALUES (?,?,?,'siwe','2099-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')").bind(crypto.randomUUID(),user,await hmac(bindings.SESSION_SECRET,token)),
  bindings.DB.prepare("INSERT INTO wallets(id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,5042002,?,'siwe')").bind(walletId,user,wallet,new Date().toISOString()),
  bindings.DB.prepare('INSERT INTO organizations(id,name,slug,industry,country,created_by) VALUES (?,?,?,?,?,?)').bind(org,'History',org,'Software','US',user),
  bindings.DB.prepare("INSERT INTO memberships(id,org_id,user_id,role) VALUES (?,?,?,'owner')").bind(crypto.randomUUID(),org,user)
 ])
 let calls=0
 const service={fetch:async(request:Request)=>{
  calls++
  const path=new URL(request.url).pathname,body=await request.json() as Record<string,unknown>
  if(path==='/v1/customer-snapshot')expect(body).toMatchObject({orgIds:[],wallets:[wallet]})
  return Response.json({configuration:disabledConfiguration,cursor:null,bindings:[],events:[],projections:[],pagination:{snapshotId:'fixture',nextToken:null,complete:true,after:0,through:0,highWater:0}})
 }} as Fetcher
 const request=(path:string)=>createWorkerApp().request('https://app.test/api/'+path,{headers:{Cookie:`retempo_session=${token}`}},{...bindings,CHAIN:service})
 return {user,org,wallet,walletId,request,calls:()=>calls}
}
it('rechecks organization RBAC on every continuation page',async()=>{
 const f=await fixture(),next=crypto.randomUUID()
 expect((await f.request(`orgs/${f.org}/chain/snapshot?pageToken=${next}`)).status).toBe(200)
 const other=crypto.randomUUID()
 await bindings.DB.batch([bindings.DB.prepare('INSERT INTO users(id,display_name) VALUES (?,?)').bind(other,'Remaining owner'),bindings.DB.prepare("INSERT INTO memberships(id,org_id,user_id,role) VALUES (?,?,?,'owner')").bind(crypto.randomUUID(),f.org,other)])
 await bindings.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_id=?').bind(f.org,f.user).run()
 expect((await f.request(`orgs/${f.org}/chain/snapshot?pageToken=${next}`)).status).toBe(404)
 expect(f.calls()).toBe(1)
})
it('rechecks SIWE ownership on every wallet and customer continuation page',async()=>{
 const f=await fixture(),next=crypto.randomUUID()
 expect((await f.request(`wallet/chain/snapshot?wallet=${f.wallet}&pageToken=${next}`)).status).toBe(200)
 expect((await f.request(`customer/chain/snapshot/pages?pageToken=${next}`)).status).toBe(200)
 await bindings.DB.prepare('DELETE FROM wallets WHERE id=?').bind(f.walletId).run()
 expect((await f.request(`wallet/chain/snapshot?wallet=${f.wallet}&pageToken=${next}`)).status).toBe(403)
 expect((await f.request(`customer/chain/snapshot/pages?pageToken=${next}`)).status).toBe(403)
 expect(f.calls()).toBe(2)
})
it('rejects malformed page tokens before calling the private service',async()=>{
 const f=await fixture()
 expect((await f.request(`orgs/${f.org}/chain/snapshot?pageToken=forged`)).status).toBe(400)
 expect((await f.request(`wallet/chain/snapshot?pageToken=forged`)).status).toBe(400)
 expect((await f.request('customer/chain/snapshot/pages?pageToken=forged')).status).toBe(400)
 expect(f.calls()).toBe(0)
})
