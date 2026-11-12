import { z } from 'zod'
import { sha256 } from '../auth/crypto'
import { requireWorkerAuth } from '../auth/guards'
import { consumeRateLimit } from '../auth/rateLimits'
import { issueChallenge, normalizeAddress, verifyChallenge } from '../auth/siwe'
import { linkWalletToUser } from '../auth/walletAuth'
import { badRequest, conflict, forbidden, notFound, unavailable } from '../errors'
import { readBody } from '../http'
import { checkoutContext, checkoutRecord } from './checkouts'
import { address, storedPlan, type C } from './plans'

const TESTNET_CHAIN_ID = 5042002
const addressBody = z.object({ address }).strict()
const verifyBody = z.object({ message: z.string().min(1).max(2000), signature: z.string().min(1).max(300) }).strict()
type CheckoutWalletContext = Awaited<ReturnType<typeof checkoutWalletContext>>

export async function customerWalletStatement(checkoutId: string, sessionId: string): Promise<string> {
  return `Link this wallet to the customer record for checkout ${checkoutId} using session reference ${await sha256(sessionId)}. This does not approve a payment, move funds, or send a transaction.`
}

async function checkoutWalletContext(c: C) {
  const row = await checkoutRecord(c)
  const detail = await checkoutContext(c, row)
  const plan = await storedPlan(c, row.org_id, detail.plan_id)
  if (Number(c.env.SIWE_CHAIN_ID) !== TESTNET_CHAIN_ID || plan.configuration.chainId !== TESTNET_CHAIN_ID) {
    throw unavailable('Customer wallet linking is unavailable for this payment configuration', 'customer_wallet_configuration')
  }
  const customer = await c.env.DB.prepare('SELECT status FROM customers WHERE org_id=? AND id=?').bind(row.org_id, detail.customer_id).first<{ status: string }>()
  if (!customer) throw notFound('Customer')
  if (customer.status !== 'active') throw conflict('This customer record is not active', 'customer_inactive')
  return { row, detail, plan }
}

function assertDistinctWallet(wallet: string, context: CheckoutWalletContext): void {
  if (wallet === context.plan.merchant.toLowerCase() || wallet === context.plan.payout.toLowerCase()) {
    throw conflict('The customer wallet must be different from the merchant and payout wallets', 'customer_wallet_collision')
  }
}

async function linkedState(c: C, auth: ReturnType<typeof requireWorkerAuth>, context: CheckoutWalletContext, wallet: string) {
  const [customerWallet, loginWallet, otherCustomer] = await Promise.all([
    c.env.DB.prepare("SELECT customer_id,verified_at,verification_method FROM wallets WHERE purpose='customer' AND org_id=? AND address=? AND chain_id=?")
      .bind(context.row.org_id, wallet, TESTNET_CHAIN_ID).first<{ customer_id: string; verified_at: string | null; verification_method: string | null }>(),
    c.env.DB.prepare("SELECT user_id,verified_at,verification_method FROM wallets WHERE purpose='login' AND address=? AND chain_id=?")
      .bind(wallet, TESTNET_CHAIN_ID).first<{ user_id: string; verified_at: string | null; verification_method: string | null }>(),
    c.env.DB.prepare("SELECT 1 AS used FROM wallets WHERE purpose='customer' AND org_id=? AND address=? AND chain_id=? AND customer_id<>?")
      .bind(context.row.org_id, wallet, TESTNET_CHAIN_ID, context.detail.customer_id).first<{ used: number }>(),
  ])
  const linked = Boolean(
    customerWallet?.customer_id === context.detail.customer_id && customerWallet.verified_at && customerWallet.verification_method === 'siwe' &&
    loginWallet?.user_id === auth.userId && loginWallet.verified_at && loginWallet.verification_method === 'siwe',
  )
  const accountConflict = Boolean(loginWallet && loginWallet.user_id !== auth.userId)
  const emailNeedsVerification = Boolean(auth.user.email && !auth.user.emailVerified)
  const reason = emailNeedsVerification ? 'email_verification_required' : otherCustomer ? 'customer_record_in_use' : accountConflict ? 'wallet_in_use' : null
  return { linked, available: reason === null, reason }
}

function requireLinkableSession(auth: ReturnType<typeof requireWorkerAuth>): void {
  if (auth.user.email && !auth.user.emailVerified) throw forbidden('Verify your email before linking a customer wallet')
}

export async function customerWalletStatus(c: C) {
  const auth = requireWorkerAuth(c)
  const parsed = address.safeParse(c.req.query('wallet') ?? '')
  if (!parsed.success) throw badRequest('A valid connected wallet is required')
  const wallet = normalizeAddress(parsed.data)
  const context = await checkoutWalletContext(c)
  if (wallet === context.plan.merchant.toLowerCase() || wallet === context.plan.payout.toLowerCase()) {
    c.header('Cache-Control', 'no-store')
    return c.json({ linked: false, available: false, reason: 'merchant_wallet' as const })
  }
  const state = await linkedState(c, auth, context, wallet)
  c.header('Cache-Control', 'no-store')
  return c.json(state)
}

export async function issueCustomerWalletChallenge(c: C) {
  const auth = requireWorkerAuth(c)
  requireLinkableSession(auth)
  const input = await readBody(c, addressBody)
  const wallet = normalizeAddress(input.address)
  const context = await checkoutWalletContext(c)
  assertDistinctWallet(wallet, context)
  const state = await linkedState(c, auth, context, wallet)
  if (!state.available) throw conflict('This wallet cannot be linked to this customer record', 'customer_wallet_unavailable')
  if (state.linked) {
    c.header('Cache-Control', 'no-store')
    return c.json({ linked: true as const, address: wallet })
  }
  await consumeRateLimit(c.env.DB, `siwe:customer-link:nonce:user:${auth.userId}`, 8, 10 * 60000)
  await consumeRateLimit(c.env.DB, `siwe:customer-link:nonce:ip:${c.get('ip')}`, 20, 10 * 60000)
  const challenge = await issueChallenge(c, {
    address: wallet,
    purpose: 'link',
    userId: auth.userId,
    statement: await customerWalletStatement(context.row.id, auth.sessionId),
  })
  c.header('Cache-Control', 'no-store')
  return c.json({ message: challenge.message, expiresAt: challenge.expiresAt }, 201)
}

export async function verifyCustomerWallet(c: C) {
  const auth = requireWorkerAuth(c)
  requireLinkableSession(auth)
  const input = await readBody(c, verifyBody)
  await consumeRateLimit(c.env.DB, `siwe:customer-link:verify:user:${auth.userId}`, 20, 10 * 60000)
  await consumeRateLimit(c.env.DB, `siwe:customer-link:verify:ip:${c.get('ip')}`, 60, 10 * 60000)
  const context = await checkoutWalletContext(c)
  const wallet = await verifyChallenge(c, {
    ...input,
    purpose: 'link',
    userId: auth.userId,
    statement: await customerWalletStatement(context.row.id, auth.sessionId),
  })
  assertDistinctWallet(wallet.address, context)
  const before = await linkedState(c, auth, context, wallet.address)
  if (!before.available) throw conflict('This wallet cannot be linked to this customer record', 'customer_wallet_unavailable')

  const existingLogin = await c.env.DB.prepare("SELECT user_id,verified_at,verification_method FROM wallets WHERE purpose='login' AND address=? AND chain_id=?")
    .bind(wallet.address, TESTNET_CHAIN_ID).first<{ user_id: string; verified_at: string | null; verification_method: string | null }>()
  if (!existingLogin || existingLogin.user_id !== auth.userId || !existingLogin.verified_at || existingLogin.verification_method !== 'siwe') {
    await linkWalletToUser(c, wallet, auth.userId)
  }

  const now = new Date().toISOString()
  const walletId = crypto.randomUUID()
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO wallets (id,purpose,org_id,customer_id,address,chain_id,label,verified_at,verification_method,created_at,updated_at)
      SELECT ?, 'customer', c.org_id, c.id, ?, ?, '', ?, 'siwe', ?, ? FROM customers c
      WHERE c.org_id=? AND c.id=? AND c.status='active'
        AND EXISTS (SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id
          WHERE u.id=? AND u.status='active' AND (u.email IS NULL OR u.email_verified_at IS NOT NULL)
            AND s.id=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.idle_expires_at>?)
        AND EXISTS (SELECT 1 FROM wallets lw WHERE lw.purpose='login' AND lw.address=? AND lw.user_id=? AND lw.chain_id=? AND lw.verified_at IS NOT NULL AND lw.verification_method='siwe')
        AND EXISTS (SELECT 1 FROM chain_checkouts cc WHERE cc.id=? AND cc.org_id=c.org_id AND cc.expires_at>?)
        AND NOT EXISTS (SELECT 1 FROM wallets other WHERE other.purpose='customer' AND other.org_id=c.org_id AND other.address=? AND other.chain_id=? AND other.customer_id<>c.id)
      ON CONFLICT(org_id,customer_id,address,chain_id) WHERE purpose='customer'
      DO UPDATE SET verified_at=excluded.verified_at,verification_method='siwe',updated_at=excluded.updated_at
      RETURNING id`)
      .bind(walletId, wallet.address, TESTNET_CHAIN_ID, now, now, now, context.row.org_id, context.detail.customer_id,
        auth.userId, auth.sessionId, now, now, wallet.address, auth.userId, TESTNET_CHAIN_ID, context.row.id, now, wallet.address, TESTNET_CHAIN_ID),
    c.env.DB.prepare(`INSERT INTO audit_logs (id,org_id,actor_user_id,actor_type,action,resource_type,resource_id,metadata,ip,user_agent,request_id)
      SELECT ?,?,?,'user','wallet.customer_linked','wallet',?,?,?,?,? WHERE changes()=1`)
      .bind(crypto.randomUUID(), context.row.org_id, auth.userId, wallet.address, JSON.stringify({ customerId: context.detail.customer_id, address: wallet.address, chainId: TESTNET_CHAIN_ID, verification: 'siwe' }), c.get('ip'), c.req.header('user-agent')?.slice(0, 300) ?? null, c.get('requestId')),
  ])
  if (!results[0]?.results.length) throw forbidden('Your session or checkout changed. Sign in again and request a new wallet proof.')

  const linked = await linkedState(c, auth, context, wallet.address)
  if (!linked.linked) throw conflict('This wallet could not be linked to the customer record', 'customer_wallet_link_failed')
  c.header('Cache-Control', 'no-store')
  return c.json({ linked: true, address: wallet.address })
}
