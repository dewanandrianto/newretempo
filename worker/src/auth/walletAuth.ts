import type { Context } from 'hono'
import type { WorkerContext } from '../types'
import { conflict, forbidden } from '../errors'
import { audit, auditStatement } from './audit'
import type { VerifiedWallet } from './siwe'
import type { SiweSessionProof } from './sessionProof'
function unique(error:unknown):boolean { return error instanceof Error && /UNIQUE constraint failed/.test(error.message) }
export async function loginWithWallet(c:Context<WorkerContext>,wallet:VerifiedWallet):Promise<SiweSessionProof> {
  const find=()=>c.env.DB.prepare("SELECT u.id,u.status,u.password_hash,w.verification_method FROM wallets w JOIN users u ON u.id=w.user_id WHERE w.purpose='login' AND w.address=?").bind(wallet.address).first<{id:string;status:string;password_hash:string|null;verification_method:string|null}>()
  let user=await find()
  if (!user) {
    const id=crypto.randomUUID(), short=`${wallet.address.slice(0,6)}...${wallet.address.slice(-4)}`
    try {
      await c.env.DB.batch([
        c.env.DB.prepare('INSERT INTO users (id,display_name) VALUES (?,?)').bind(id,`Wallet ${short}`),
        c.env.DB.prepare("INSERT INTO wallets (id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,?,?,'siwe')").bind(crypto.randomUUID(),id,wallet.address,Number(c.env.SIWE_CHAIN_ID),new Date().toISOString()),
        auditStatement(c,id,'user.registered','user',id,{method:'siwe'}),
      ])
      user={id,status:'active',password_hash:null,verification_method:'siwe'}
    } catch(error) { if (!unique(error)) throw error; user=await find() }
  }
  if (!user || user.status!=='active') throw forbidden('This wallet account is not active')
  if (user.verification_method!=='siwe') throw forbidden('Wallet sign-in was revoked. Sign in with your recovered password and link your wallet again.')
  const proof:SiweSessionProof={method:'siwe',userId:user.id,passwordHash:user.password_hash,address:wallet.address}
  await c.env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(new Date().toISOString(),user.id).run()
  await audit(c,user.id,'auth.login','user',user.id,{method:'siwe'})
  return proof
}
export async function linkWalletToUser(c:Context<WorkerContext>,wallet:VerifiedWallet,userId:string):Promise<void> {
  if (wallet.userId!==userId) throw forbidden('This challenge was issued to a different account')
  const auth=c.get('auth'), now=new Date().toISOString()
  if (!auth || auth.userId!==userId) throw forbidden('Sign in again before linking a wallet')
  // Recheck authorization inside the mutation: an already authenticated request
  // must not resurrect access after a concurrent password reset revokes its session.
  const mutation=c.env.DB.prepare(`INSERT INTO wallets (id,purpose,user_id,address,chain_id,verified_at,verification_method)
    SELECT ?,'login',u.id,?,?,?,'siwe' FROM users u JOIN sessions s ON s.user_id=u.id
    WHERE u.id=? AND u.status='active' AND (u.email IS NULL OR u.email_verified_at IS NOT NULL)
      AND s.id=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.idle_expires_at>?
    ON CONFLICT(address) WHERE purpose='login' DO UPDATE SET verification_method='siwe',verified_at=excluded.verified_at,updated_at=excluded.verified_at
      WHERE wallets.user_id=excluded.user_id AND wallets.verification_method IS NULL
    RETURNING id`).bind(crypto.randomUUID(),wallet.address,Number(c.env.SIWE_CHAIN_ID),now,userId,auth.sessionId,now,now)
  const results=await c.env.DB.batch([mutation,
    c.env.DB.prepare(`INSERT INTO audit_logs (id,actor_user_id,actor_type,action,resource_type,resource_id,metadata,ip,user_agent,request_id)
      SELECT ?,?,'user','wallet.linked','wallet',id,?,?,?,? FROM wallets
      WHERE purpose='login' AND address=? AND user_id=? AND changes()=1`).bind(crypto.randomUUID(),userId,JSON.stringify({address:wallet.address}),c.get('ip'),c.req.header('user-agent')?.slice(0,300)??null,c.get('requestId'),wallet.address,userId),
  ])
  const result=results[0]
  if (!result.results.length) {
    const existing=await c.env.DB.prepare("SELECT user_id,verification_method FROM wallets WHERE purpose='login' AND address=?").bind(wallet.address).first<{user_id:string;verification_method:string|null}>()
    if (existing && (existing.user_id!==userId || existing.verification_method==='siwe')) throw conflict('This wallet is already linked to an account','wallet_in_use')
    throw forbidden('Verify your email and sign in again before linking a wallet')
  }
}
