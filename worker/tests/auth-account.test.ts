import { env } from 'cloudflare:test'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { loadWorkerAccount } from '../src/auth/account'
import { requireWorkerAuth, requireWorkerOrg, resourceId } from '../src/auth/guards'
import { can, outranks, type OrgRole } from '../src/auth/permissions'
import { HttpError } from '../src/errors'
import type { WorkerBindings, WorkerContext } from '../src/types'
const db=(env as unknown as WorkerBindings).DB
const userId=crypto.randomUUID(), orgId=crypto.randomUUID()
function app() {
  const a=new Hono<WorkerContext>()
  a.use('*',async(c,next)=>{
    c.set('auth',c.req.header('x-anonymous') ? null : {sessionId:'test',userId:c.req.header('x-user')??userId,method:'password',user:{id:userId,email:'membership@example.test',emailVerified:true,displayName:'Test'}})
    await next()
  })
  a.onError((e,c)=>e instanceof HttpError?c.json({error:e.code},e.status as 400):c.json({error:e.message},500))
  a.get('/me',async c=>c.json(await loadWorkerAccount(c,requireWorkerAuth(c).userId)))
  a.get('/orgs/:orgId',async c=>c.json(await requireWorkerOrg(c,'org:read')))
  a.post('/orgs/:orgId',async c=>c.json(await requireWorkerOrg(c,'catalog:write')))
  a.get('/resources/:id',c=>c.json({id:resourceId(c)}))
  return a
}
const request=(path:string,method='GET',headers:Record<string,string>={})=>app().request(`https://app.test${path}`,{method,headers},env)
describe('account and tenant authorization',()=>{
  it('loads the original frontend account membership shape and enforces roles without disclosing other tenants',async()=>{
    await db.batch([
      db.prepare('INSERT INTO users (id,email,display_name) VALUES (?,?,?)').bind(userId,'membership@example.test','Test'),
      db.prepare('INSERT INTO organizations (id,name,slug,industry,country,created_by) VALUES (?,?,?,?,?,?)').bind(orgId,'Test Organization','test-memberships','Software','Indonesia',userId),
      db.prepare('INSERT INTO memberships (id,org_id,user_id,role) VALUES (?,?,?,?)').bind(crypto.randomUUID(),orgId,userId,'member'),
    ])
    const account=await(await request('/me')).json()
    expect(account).toMatchObject({user:{id:userId,email:'membership@example.test',emailVerified:false,wallets:[]},memberships:[{role:'member',organization:{id:orgId,name:'Test Organization',slug:'test-memberships',website:null,industry:'Software',country:'Indonesia'}}]})
    expect((await request(`/orgs/${orgId}`)).status).toBe(200)
    expect((await request(`/orgs/${orgId}`,'POST')).status).toBe(403)
    expect((await request(`/orgs/${orgId}`,'GET',{'x-user':crypto.randomUUID()})).status).toBe(404)
    expect((await request(`/orgs/${orgId}`,'GET',{'x-anonymous':'true'})).status).toBe(401)
    expect((await request('/orgs/not-a-uuid')).status).toBe(404)
    expect((await request('/resources/not-a-uuid')).status).toBe(404)
    await db.prepare("UPDATE memberships SET role='admin' WHERE org_id=?").bind(orgId).run()
    expect((await request(`/orgs/${orgId}`,'POST')).status).toBe(200)
    await db.prepare("UPDATE organizations SET status='archived' WHERE id=?").bind(orgId).run()
    expect((await request(`/orgs/${orgId}`)).status).toBe(404)
    expect(await(await request('/me')).json()).toMatchObject({memberships:[]})
  })
  it('preserves the legacy permission ranking',()=>{
    for (const role of ['member','admin','owner'] as OrgRole[]) {
      expect(can(role,'org:read')).toBe(true)
      expect(can(role,'members:read')).toBe(true)
      expect(can(role,'customers:write')).toBe(true)
      expect(can(role,'invoices:write')).toBe(true)
      expect(can(role,'catalog:write')).toBe(role!=='member')
      expect(can(role,'api_keys:manage')).toBe(role!=='member')
    }
    expect(outranks('owner','admin')).toBe(true)
    expect(outranks('admin','admin')).toBe(false)
    expect(outranks('member','owner')).toBe(false)
  })
})
