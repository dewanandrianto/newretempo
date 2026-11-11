import type { Context } from 'hono'
import type { WorkerContext } from '../types'
import { conflict, unauthorized } from '../errors'
import { assertPasswordPolicy, hashPassword, verifyPassword } from './passwords'
import { consumeRateLimit } from './rateLimits'
import { assertMailer, sendLink, applyEmailToken } from './emailTokens'
import { audit, auditStatement } from './audit'
import type { PasswordSessionProof, PrivySessionProof } from './sessionProof'
type C = Context<WorkerContext>
export async function registerUser(c:C,input:{email:string;password:string;name:string}) {
  await consumeRateLimit(c.env.DB,`register:ip:${c.get('ip')}`,10,3600000)
  assertMailer(c)
  assertPasswordPolicy(input.password,input.email)
  const hash=await hashPassword(input.password),userId=crypto.randomUUID()
  try { await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO users (id,email,password_hash,display_name) VALUES (?,?,?,?)').bind(userId,input.email,hash,input.name),
    auditStatement(c,userId,'user.registered'),
  ]) } catch(error) { if (error instanceof Error && /UNIQUE constraint failed: users.email/.test(error.message)) throw conflict('An account with this email already exists','email_taken'); throw error }
  // Retain the exact created credential across asynchronous mail delivery.
  const proof:PasswordSessionProof={method:'password',userId,passwordHash:hash}
  return {proof,verificationEmailSent:await sendLink(c,userId,input.email,'verify_email')}
}
export async function authenticatePassword(c:C,input:{email:string;password:string}):Promise<PasswordSessionProof> {
  await consumeRateLimit(c.env.DB,`login:ip:${c.get('ip')}`,20,15*60000)
  await consumeRateLimit(c.env.DB,`login:email:${input.email}`,8,15*60000)
  const user=await c.env.DB.prepare('SELECT id,password_hash,status FROM users WHERE email=?').bind(input.email).first<{id:string;password_hash:string|null;status:string}>()
  const valid=await verifyPassword(input.password,user?.password_hash??'')
  if (!user||!valid||user.status!=='active') { await audit(c,user?.id??null,'auth.login_failed'); throw unauthorized('Invalid email or password') }
  const proof:PasswordSessionProof={method:'password',userId:user.id,passwordHash:user.password_hash!}
  await c.env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(new Date().toISOString(),user.id).run()
  await audit(c,user.id,'auth.login','user',user.id,{method:'password'})
  return proof
}
async function findPrivyUser(c:C,privyUserId:string) {
  return c.env.DB.prepare(`SELECT p.user_id,u.status FROM privy_identities p JOIN users u ON u.id=p.user_id WHERE p.privy_user_id=?`)
    .bind(privyUserId).first<{user_id:string;status:string}>()
}
async function recordPrivyLogin(c:C,userId:string) {
  const now=new Date().toISOString()
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=? AND status=\'active\'').bind(now,userId),
    auditStatement(c,userId,'auth.login','user',userId,{method:'privy'}),
  ])
}
export async function authenticatePrivy(c:C,privyUserId:string):Promise<PrivySessionProof> {
  let mapped=await findPrivyUser(c,privyUserId)
  if (mapped) {
    if (mapped.status!=='active') throw unauthorized('Privy sign-in failed')
    await recordPrivyLogin(c,mapped.user_id)
    return {method:'privy',userId:mapped.user_id,privyUserId}
  }

  const userId=crypto.randomUUID(),now=new Date().toISOString()
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users (id,email,password_hash,display_name,last_login_at) VALUES (?,NULL,NULL,'',?)").bind(userId,now),
      c.env.DB.prepare('INSERT INTO privy_identities (privy_user_id,user_id) VALUES (?,?)').bind(privyUserId,userId),
      auditStatement(c,userId,'user.registered','user',userId,{method:'privy'}),
      auditStatement(c,userId,'auth.login','user',userId,{method:'privy'}),
    ])
  } catch (error) {
    if (!String(error).includes('UNIQUE constraint failed: privy_identities.privy_user_id')) throw error
    // A parallel first login won the unique DID insert; adopt only that exact mapping.
    mapped=await findPrivyUser(c,privyUserId)
    if (!mapped) throw error
    if (mapped.status!=='active') throw unauthorized('Privy sign-in failed')
    await recordPrivyLogin(c,mapped.user_id)
    return {method:'privy',userId:mapped.user_id,privyUserId}
  }
  return {method:'privy',userId,privyUserId}
}
export async function linkPrivyIdentity(c:C,userId:string,privyUserId:string):Promise<void> {
  await consumeRateLimit(c.env.DB,`privy:link:user:${userId}`,5,60*60000)
  const now=new Date().toISOString()
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO privy_identities (privy_user_id,user_id,created_at)
        SELECT ?,u.id,? FROM users u WHERE u.id=? AND u.status='active'
        ON CONFLICT(privy_user_id) DO NOTHING`).bind(privyUserId,now,userId),
      c.env.DB.prepare(`INSERT INTO audit_logs (id,actor_user_id,actor_type,action,resource_type,resource_id,metadata,ip,user_agent,request_id)
        SELECT ?,?,'user','auth.privy_linked','user',?,'{"method":"privy"}',?,?,?
        WHERE EXISTS (SELECT 1 FROM privy_identities WHERE privy_user_id=? AND user_id=?)`).bind(crypto.randomUUID(),userId,userId,c.get('ip'),c.req.header('user-agent')?.slice(0,300)??null,c.get('requestId'),privyUserId,userId),
    ])
  } catch (error) {
    if (!String(error).includes('UNIQUE constraint failed: privy_identities.user_id')) throw error
  }
  const byIdentity=await findPrivyUser(c,privyUserId)
  if (byIdentity?.user_id===userId && byIdentity.status==='active') return
  if (byIdentity) throw conflict('This Privy sign-in is linked to another account','privy_identity_taken')
  const other=await c.env.DB.prepare('SELECT privy_user_id FROM privy_identities WHERE user_id=?').bind(userId).first<{privy_user_id:string}>()
  if (other) throw conflict('This account already has a different Privy sign-in linked','privy_account_linked')
  throw unauthorized('This account is no longer available')
}
export async function verifyEmail(c:C,token:string) { await consumeRateLimit(c.env.DB,`verify:ip:${c.get('ip')}`,20,10*60000); await applyEmailToken(c,token,'verify_email') }
export async function resendVerification(c:C,userId:string,email:string|null,verified:boolean):Promise<boolean> {
  await consumeRateLimit(c.env.DB,`resend:user:${userId}`,3,30*60000)
  if (!email||verified) return false
  assertMailer(c)
  return sendLink(c,userId,email,'verify_email')
}
export async function requestPasswordReset(c:C,email:string):Promise<void> {
  await consumeRateLimit(c.env.DB,`forgot:ip:${c.get('ip')}`,10,3600000)
  await consumeRateLimit(c.env.DB,`forgot:email:${email}`,3,3600000)
  assertMailer(c)
  const user=await c.env.DB.prepare("SELECT id FROM users WHERE email=? AND status='active'").bind(email).first<{id:string}>()
  if (user) { await sendLink(c,user.id,email,'reset_password'); await audit(c,user.id,'auth.password_reset_requested') }
}
export async function resetPassword(c:C,token:string,password:string):Promise<void> {
  await consumeRateLimit(c.env.DB,`reset:ip:${c.get('ip')}`,10,3600000)
  assertPasswordPolicy(password)
  await applyEmailToken(c,token,'reset_password',await hashPassword(password))
}
