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
  const existing=await c.env.DB.prepare("SELECT user_id,chain_id FROM wallets WHERE purpose='login' AND address=?").bind(wallet.address).first<{user_id:string;chain_id:number}>()
  if(existing?.user_id===userId&&existing.chain_id!==Number(c.env.SIWE_CHAIN_ID)) throw conflict('This wallet is already linked on a different network; choose another wallet instead of changing its existing mapping','wallet_chain_conflict')
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

/** Adds a signature-proven wallet only to the already authenticated Privy owner account and org. */
export async function linkMerchantWalletToOwner(c:Context<WorkerContext>,wallet:VerifiedWallet,userId:string,orgId:string):Promise<void> {
  const auth=c.get('auth'),now=new Date().toISOString(),chainId=5042002
  if (wallet.userId!==userId || !auth || auth.userId!==userId || auth.method!=='privy') throw forbidden('Sign in to the existing Privy owner account before linking a merchant wallet')
  const relations=await c.env.DB.prepare(`SELECT
    EXISTS(SELECT 1 FROM wallets WHERE purpose='login' AND address=? AND user_id<>?) AS other_account,
    EXISTS(SELECT 1 FROM wallets WHERE purpose='login' AND address=? AND user_id=? AND chain_id<>?) AS wrong_chain,
    EXISTS(SELECT 1 FROM wallets WHERE purpose='customer' AND address=?) AS customer_relation,
    EXISTS(SELECT 1 FROM wallets WHERE purpose='payout' AND address=? AND org_id<>?) AS other_merchant`)
    .bind(wallet.address,userId,wallet.address,userId,chainId,wallet.address,wallet.address,orgId)
    .first<{other_account:number;wrong_chain:number;customer_relation:number;other_merchant:number}>()
  if (relations && (relations.other_account || relations.wrong_chain || relations.customer_relation || relations.other_merchant)) {
    throw conflict('This wallet is already associated with another account, customer, or merchant workspace','wallet_in_use')
  }

  const mutation=c.env.DB.prepare(`WITH eligible_owner AS (
      SELECT u.id AS user_id,o.id AS org_id FROM users u
      JOIN sessions s ON s.user_id=u.id
      JOIN memberships m ON m.user_id=u.id AND m.org_id=?
      JOIN organizations o ON o.id=m.org_id
      JOIN privy_identities p ON p.user_id=u.id
      WHERE u.id=? AND u.status='active' AND (u.email IS NULL OR u.email_verified_at IS NOT NULL)
      AND m.role='owner' AND o.status='active' AND s.id=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.idle_expires_at>?
      AND COALESCE(s.auth_provider,s.auth_method)='privy'
      AND NOT EXISTS(SELECT 1 FROM wallets w WHERE w.purpose='login' AND w.address=? AND w.user_id<>?)
      AND NOT EXISTS(SELECT 1 FROM wallets w WHERE w.purpose='login' AND w.address=? AND w.user_id=? AND w.chain_id<>?)
      AND NOT EXISTS(SELECT 1 FROM wallets w WHERE w.purpose='customer' AND w.address=?)
      AND NOT EXISTS(SELECT 1 FROM wallets w WHERE w.purpose='payout' AND w.address=? AND w.org_id<>?)
    ), wallet_rows AS (
      SELECT ? AS id,'login' AS purpose,NULL AS org_id,user_id,NULL AS customer_id,? AS address,? AS chain_id,'Verified merchant wallet' AS label,? AS verified_at,'siwe' AS verification_method,? AS created_at,? AS updated_at FROM eligible_owner
      UNION ALL
      SELECT ?,'payout',org_id,NULL,NULL,?,?,'Verified merchant wallet',?,'siwe',?,? FROM eligible_owner
    )
    INSERT INTO wallets (id,purpose,org_id,user_id,customer_id,address,chain_id,label,verified_at,verification_method,created_at,updated_at)
    SELECT id,purpose,org_id,user_id,customer_id,address,chain_id,label,verified_at,verification_method,created_at,updated_at FROM wallet_rows WHERE 1=1
    ON CONFLICT(address) WHERE purpose='login' DO UPDATE SET
      user_id=CASE WHEN wallets.user_id=excluded.user_id AND wallets.chain_id=excluded.chain_id THEN excluded.user_id ELSE NULL END,
      verification_method='siwe',verified_at=excluded.verified_at,updated_at=excluded.updated_at
    ON CONFLICT(org_id,address,chain_id) WHERE purpose='payout' DO UPDATE SET verified_at=excluded.verified_at,verification_method='siwe',updated_at=excluded.updated_at
    RETURNING purpose,id`)
    .bind(orgId,userId,auth.sessionId,now,now,wallet.address,userId,wallet.address,userId,chainId,wallet.address,wallet.address,orgId,
      crypto.randomUUID(),wallet.address,chainId,now,now,now,crypto.randomUUID(),wallet.address,chainId,now,now,now)
  const audit=c.env.DB.prepare(`INSERT INTO audit_logs
    (id,org_id,actor_user_id,actor_type,action,resource_type,resource_id,metadata,ip,user_agent,request_id,created_at)
    SELECT ?,?,?,'user','merchant.wallet.verified','wallet',?,?,?, ?,?,?
    WHERE changes()=2`)
    .bind(crypto.randomUUID(),orgId,userId,wallet.address,JSON.stringify({chainId,verificationMethod:'siwe'}),c.get('ip'),c.req.header('User-Agent')?.slice(0,300)??null,c.get('requestId'),now)
  const results=await c.env.DB.batch([mutation,audit])
  const written=results[0].results as Array<{purpose:string;id:string}>
  if (written.length!==2 || !written.some(row=>row.purpose==='login') || !written.some(row=>row.purpose==='payout')) {
    const collision=await c.env.DB.prepare(`SELECT
      EXISTS(SELECT 1 FROM wallets WHERE purpose='login' AND address=? AND user_id<>?) AS other_account,
      EXISTS(SELECT 1 FROM wallets WHERE purpose='login' AND address=? AND user_id=? AND chain_id<>?) AS wrong_chain,
      EXISTS(SELECT 1 FROM wallets WHERE purpose='customer' AND address=?) AS customer_relation,
      EXISTS(SELECT 1 FROM wallets WHERE purpose='payout' AND address=? AND org_id<>?) AS other_merchant`)
      .bind(wallet.address,userId,wallet.address,userId,chainId,wallet.address,wallet.address,orgId)
      .first<{other_account:number;wrong_chain:number;customer_relation:number;other_merchant:number}>()
    if (collision && (collision.other_account || collision.wrong_chain || collision.customer_relation || collision.other_merchant)) {
      throw conflict('This wallet is already associated with another account, customer, or merchant workspace','wallet_in_use')
    }
    throw forbidden('The active Privy owner session changed; reload and try again')
  }
}
