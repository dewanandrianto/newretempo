import type { Context } from 'hono'
import type { WorkerContext } from '../types'
import { unavailable, unauthorized } from '../errors'
import { hmac, randomToken } from './crypto'
export type EmailTokenPurpose = 'verify_email' | 'reset_password'
export function assertMailer(c:Context<WorkerContext>): void {
  if (!c.env.MAILER || c.env.EMAIL_MODE === 'disabled' || (c.env.APP_ENV === 'production' && c.env.EMAIL_MODE === 'test')) throw unavailable('Email delivery is not configured on this server', 'email_not_configured')
}
export async function sendLink(c:Context<WorkerContext>,userId:string,email:string,purpose:EmailTokenPurpose):Promise<boolean> {
  assertMailer(c)
  const token=randomToken(), id=crypto.randomUUID(), now=new Date().toISOString(), hash=await hmac(c.env.SESSION_SECRET,token)
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE email_tokens SET used_at=? WHERE user_id=? AND purpose=? AND used_at IS NULL').bind(now,userId,purpose),
    c.env.DB.prepare('INSERT INTO email_tokens (id,user_id,purpose,email,token_hash,expires_at) VALUES (?,?,?,?,?,?)').bind(id,userId,purpose,email,hash,new Date(Date.now()+(purpose==='verify_email'?86400000:3600000)).toISOString()),
  ])
  const base=(c.env.APP_ORIGINS.split(',')[0]?.trim()||c.env.SIWE_URI).replace(/\/$/,'')
  const link=`${base}${purpose==='verify_email'?'/verify-email':'/reset-password'}#${token}`
  try {
    const response=await c.env.MAILER!.fetch(new Request('https://mailer.internal/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to:email,kind:purpose,subject:purpose==='verify_email'?'Verify your RETEMPO email':'Reset your RETEMPO password',link})}))
    if (response.ok) return true
  } catch { /* Never log adapter errors, which may include the token or message body. */ }
  await c.env.DB.prepare('UPDATE email_tokens SET used_at=? WHERE id=? AND used_at IS NULL').bind(new Date().toISOString(),id).run()
  return false
}
/** All account changes and token consumption are one serialized D1 transaction. */
export async function applyEmailToken(c:Context<WorkerContext>,token:string,purpose:EmailTokenPurpose,passwordHash?:string):Promise<void> {
  const hash=await hmac(c.env.SESSION_SECRET,token), now=new Date().toISOString(), db=c.env.DB
  const valid=`SELECT t.user_id FROM email_tokens t JOIN users u ON u.id=t.user_id AND u.email=t.email AND u.status='active' WHERE t.token_hash=? AND t.purpose=? AND t.used_at IS NULL AND t.expires_at>?`
  const pending:D1PreparedStatement[]=[]
  if (purpose==='reset_password') {
    pending.push(db.prepare(`UPDATE users SET password_hash=?,email_verified_at=coalesce(email_verified_at,?) WHERE id IN (${valid})`).bind(passwordHash!,now,hash,purpose,now))
    pending.push(db.prepare(`UPDATE sessions SET revoked_at=?,revoked_reason='password_reset' WHERE revoked_at IS NULL AND user_id IN (${valid})`).bind(now,hash,purpose,now))
    // Keep address ownership reserved. NULL verification_method tombstones login access
    // without violating the existing login verified_at constraint or touching financial wallets.
    pending.push(db.prepare(`UPDATE wallets SET verification_method=NULL,updated_at=? WHERE purpose='login' AND user_id IN (${valid})`).bind(now,hash,purpose,now))
    pending.push(db.prepare(`UPDATE siwe_nonces SET used_at=? WHERE purpose='link' AND used_at IS NULL AND user_id IN (${valid})`).bind(now,hash,purpose,now))
  } else pending.push(db.prepare(`UPDATE users SET email_verified_at=coalesce(email_verified_at,?) WHERE id IN (${valid})`).bind(now,hash,purpose,now))
  // Conditional audit in the same transaction: a replay produces no audit or account changes.
  pending.push(db.prepare(`INSERT INTO audit_logs (id,actor_user_id,actor_type,action,resource_type,resource_id,ip,request_id) SELECT ?,user_id,'user',?,'user',user_id,?,? FROM email_tokens WHERE user_id IN (${valid}) AND token_hash=?`).bind(crypto.randomUUID(),purpose==='reset_password'?'auth.password_reset':'user.email_verified',c.get('ip'),c.get('requestId'),hash,purpose,now,hash))
  pending.push(db.prepare(`UPDATE email_tokens SET used_at=? WHERE token_hash=? AND user_id IN (${valid}) RETURNING user_id`).bind(now,hash,hash,purpose,now))
  const result=await db.batch(pending)
  if (!result.at(-1)!.results.length) throw unauthorized(purpose==='reset_password'?'This reset link is invalid or has expired':'This verification link is invalid or has expired')
}
