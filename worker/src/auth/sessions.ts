import type { Context } from 'hono'
import type { AuthContext, AuthRequest, WorkerContext, WorkerBindings } from '../types'
import { hmac, randomToken } from './crypto'
import { forbidden } from '../errors'
import type { SessionProof } from './sessionProof'

function secure(env: WorkerBindings) { return env.APP_ENV === 'production' || env.COOKIE_SECURE === 'true' }
export function sessionCookieName(env: WorkerBindings) { return secure(env) ? '__Host-retempo_session' : 'retempo_session' }
function readToken(c: AuthRequest): string | null {
  const name = sessionCookieName(c.env)
  for (const part of (c.req.header('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (part.slice(0, i).trim() === name) {
      try { const token = decodeURIComponent(part.slice(i + 1).trim()); return /^[0-9a-f]{64}$/.test(token) ? token : null } catch { return null }
    }
  }
  return null
}
function hours(value: string | undefined, fallback: number): number { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback }
const ttlMs = (env: WorkerBindings) => hours(env.SESSION_TTL_HOURS, 24 * 7) * 3600000
const idleMs = (env: WorkerBindings) => hours(env.SESSION_IDLE_HOURS, 24) * 3600000
function setCookie(c: Context<WorkerContext>, token: string, seconds: number) {
  c.header('Set-Cookie', `${sessionCookieName(c.env)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${seconds === 0 ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : ''}${secure(c.env) ? '; Secure' : ''}`, {append: true})
}
export function expireCookie(c: Context<WorkerContext>) { setCookie(c, '', 0) }
export async function resolveAuth(c: AuthRequest): Promise<AuthContext | null> {
  const token = readToken(c)
  if (!token) return null
  const now = new Date().toISOString()
  const row = await c.env.DB.prepare(`SELECT s.id,s.user_id,coalesce(s.auth_provider,s.auth_method) AS auth_method,s.last_seen_at,s.expires_at,u.email,u.email_verified_at,u.display_name
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.idle_expires_at>? AND u.status='active'`).bind(await hmac(c.env.SESSION_SECRET, token), now, now).first<{id:string;user_id:string;auth_method:'password'|'siwe'|'privy';last_seen_at:string;expires_at:string;email:string|null;email_verified_at:string|null;display_name:string}>()
  if (!row) return null
  if (Date.now() - Date.parse(row.last_seen_at) >= 60000) await c.env.DB.prepare('UPDATE sessions SET last_seen_at=?,idle_expires_at=? WHERE id=? AND revoked_at IS NULL').bind(now, new Date(Math.min(Date.parse(row.expires_at), Date.now()+idleMs(c.env))).toISOString(),row.id).run()
  return {sessionId:row.id,userId:row.user_id,method:row.auth_method,user:{id:row.user_id,email:row.email,emailVerified:row.email_verified_at!==null,displayName:row.display_name}}
}
export async function establishSession(c: Context<WorkerContext>, proof: SessionProof): Promise<void> {
  // Keep the mandatory typed boundary fail-closed for untyped internal callers too.
  if (!proof || typeof proof.userId!=='string' ||
      (proof.method!=='password' && proof.method!=='siwe' && proof.method!=='privy') ||
      (proof.method==='password' && (typeof proof.passwordHash!=='string' || proof.passwordHash==='')) ||
      (proof.method==='siwe' && ((typeof proof.passwordHash!=='string' && proof.passwordHash!==null) || !/^0x[0-9a-f]{40}$/.test(proof.address))) ||
      (proof.method==='privy' && !/^did:privy:.{1,245}$/.test(proof.privyUserId))) {
    throw forbidden('Sign-in is no longer valid. Authenticate again.')
  }
  const {userId,method}=proof
  const passwordHash=method==='privy'?null:proof.passwordHash
  const now = new Date().toISOString(), token=randomToken(), id=crypto.randomUUID(), previous=readToken(c)
  // Existing password and SIWE sessions retain their credential/ownership fence.
  const walletAdmission=method==='siwe' ? ` AND EXISTS (
    SELECT 1 FROM wallets w WHERE w.purpose='login' AND w.address=? AND w.user_id=u.id
      AND w.verification_method='siwe' AND w.verified_at IS NOT NULL)` : ''
  const sessionMethod=method==='siwe'?'siwe':'password'
  const authProvider=method==='privy'?'privy':null
  const proofAdmission=method==='privy' ? ` AND EXISTS (
    SELECT 1 FROM privy_identities p WHERE p.privy_user_id=? AND p.user_id=u.id)` : ` AND u.password_hash IS ?${walletAdmission}`
  const values: (string|null)[]=[id,userId,await hmac(c.env.SESSION_SECRET,token),sessionMethod,authProvider,c.get('ip'),c.req.header('user-agent')?.slice(0,300)??null,now,new Date(Date.now()+Math.min(ttlMs(c.env),idleMs(c.env))).toISOString(),new Date(Date.now()+ttlMs(c.env)).toISOString(),userId]
  if (method==='privy') values.push(proof.privyUserId)
  else {
    values.push(passwordHash)
    if (method==='siwe') values.push(proof.address)
  }
  const queries=[c.env.DB.prepare(`INSERT INTO sessions (id,user_id,token_hash,auth_method,auth_provider,ip,user_agent,last_seen_at,idle_expires_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,? FROM users u WHERE u.id=? AND u.status='active'${proofAdmission} RETURNING id`).bind(...values)]
  // A denied proof must not revoke the browser's existing session. This guarded
  // rotation and the admitted INSERT commit or roll back together.
  if (previous) queries.push(c.env.DB.prepare("UPDATE sessions SET revoked_at=?,revoked_reason='rotated' WHERE token_hash=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM sessions WHERE id=?)").bind(now,await hmac(c.env.SESSION_SECRET,previous),id))
  const result=await c.env.DB.batch(queries)
  if (!result[0].results.length) throw forbidden('Sign-in is no longer valid. Authenticate again.')
  setCookie(c,token,Math.floor(ttlMs(c.env)/1000))
  const user=await c.env.DB.prepare('SELECT email,email_verified_at,display_name FROM users WHERE id=?').bind(userId).first<{email:string|null;email_verified_at:string|null;display_name:string}>()
  c.set('auth',{sessionId:id,userId,method,user:{id:userId,email:user!.email,emailVerified:user!.email_verified_at!==null,displayName:user!.display_name}})
}
export async function revokeSession(db:D1Database, sessionId:string, reason:string) { await db.prepare('UPDATE sessions SET revoked_at=?,revoked_reason=? WHERE id=? AND revoked_at IS NULL').bind(new Date().toISOString(),reason,sessionId).run() }
