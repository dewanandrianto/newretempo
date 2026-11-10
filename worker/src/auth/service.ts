import type { Context } from 'hono'
import type { WorkerContext } from '../types'
import { conflict, unauthorized } from '../errors'
import { assertPasswordPolicy, hashPassword, verifyPassword } from './passwords'
import { consumeRateLimit } from './rateLimits'
import { assertMailer, sendLink, applyEmailToken } from './emailTokens'
import { audit, auditStatement } from './audit'
import type { PasswordSessionProof } from './sessionProof'
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
