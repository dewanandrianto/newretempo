import type { Context } from 'hono'
import type { WorkerContext } from '../types'
import { notFound } from '../errors'
import type { OrgRole } from './permissions'
export async function loadWorkerAccount(c: Context<WorkerContext>, userId: string) {
  const db=c.env.DB
  const u=await db.prepare('SELECT id,email,email_verified_at,display_name FROM users WHERE id=?').bind(userId).first<{id:string;email:string|null;email_verified_at:string|null;display_name:string}>()
  if (!u) throw notFound('User')
  const wallets=await db.prepare("SELECT address,chain_id FROM wallets WHERE purpose='login' AND verification_method='siwe' AND verified_at IS NOT NULL AND user_id=? ORDER BY created_at").bind(userId).all<{address:string;chain_id:number}>()
  const memberships=await db.prepare("SELECT m.role,o.id,o.name,o.slug,o.website,o.industry,o.country FROM memberships m JOIN organizations o ON o.id=m.org_id JOIN users member_user ON member_user.id=m.user_id WHERE m.user_id=? AND o.status='active' AND (o.created_by=member_user.id OR (member_user.email IS NOT NULL AND member_user.email_verified_at IS NOT NULL)) ORDER BY m.created_at").bind(userId).all<{role:OrgRole;id:string;name:string;slug:string;website:string|null;industry:string;country:string}>()
  return {user:{id:u.id,email:u.email,emailVerified:u.email_verified_at!==null,displayName:u.display_name,wallets:wallets.results.map(w=>({address:w.address,chainId:Number(w.chain_id)}))}, memberships:memberships.results.map(m=>({role:m.role,organization:{id:m.id,name:m.name,slug:m.slug,website:m.website,industry:m.industry,country:m.country}}))}
}
