import type { Context } from 'hono'
import { getAddress, recoverMessageAddress } from 'viem'
import { createSiweMessage } from 'viem/siwe'
import { z } from 'zod'
import type { WorkerApp, WorkerContext } from '../types'
import { requireWorkerAuth, requireWorkerOrg } from '../auth/guards'
import { consumeRateLimit } from '../auth/rateLimits'
import { randomToken, sha256 } from '../auth/crypto'
import { checkSiweMessage, normalizeAddress } from '../auth/siwe'
import { linkMerchantWalletToOwner } from '../auth/walletAuth'
import { loadWorkerAccount } from '../auth/account'
import { badRequest, conflict, forbidden, unauthorized } from '../errors'
import { readBody } from '../http'

const TESTNET_CHAIN_ID = 5042002
const CHALLENGE_TTL_MS = 5 * 60_000
const STATEMENT = 'Verify and link this merchant wallet to your current RETEMPO account and organization. This does not create or switch accounts, send a transaction, or cost gas.'
const addressBody = z.object({ address: z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/) }).strict()
const verifyBody = z.object({ message: z.string().min(1).max(2000), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict()

interface WalletRelations {
  other_account: number
  wrong_chain: number
  customer_relation: number
  other_merchant: number
}

type WalletUnavailableReason = 'wallet_in_use' | null

async function requirePrivyOwner(c: Context<WorkerContext>) {
  const auth = requireWorkerAuth(c)
  const { orgId, role } = await requireWorkerOrg(c, 'wallets:write')
  if (role !== 'owner') throw forbidden('Only the organization owner can verify a merchant wallet')
  if (auth.method !== 'privy') throw forbidden('Sign in to the existing Privy account for this organization before verifying a merchant wallet')
  if (Number(c.env.SIWE_CHAIN_ID) !== TESTNET_CHAIN_ID) throw forbidden('Merchant wallet verification is available only on the configured Testnet')
  if (!c.env.SIWE_DOMAIN || !c.env.SIWE_URI) throw badRequest('Wallet verification is not configured on this server')
  const now = new Date().toISOString()
  const active = await c.env.DB.prepare(`SELECT 1 AS allowed
    FROM sessions s
    JOIN users u ON u.id=s.user_id
    JOIN memberships m ON m.user_id=u.id AND m.org_id=?
    JOIN organizations o ON o.id=m.org_id
    JOIN privy_identities p ON p.user_id=u.id
    WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.idle_expires_at>?
      AND COALESCE(s.auth_provider,s.auth_method)='privy' AND u.status='active' AND m.role='owner' AND o.status='active'
    LIMIT 1`).bind(orgId, auth.sessionId, auth.userId, now, now).first<{ allowed: number }>()
  if (!active) throw forbidden('The active Privy session is no longer the owner of this organization')
  return { auth, orgId, now }
}

async function walletRelations(c: Context<WorkerContext>, address: string, userId: string, orgId: string) {
  const relations = await c.env.DB.prepare(`SELECT
    EXISTS(SELECT 1 FROM wallets WHERE purpose='login' AND address=? AND user_id<>?) AS other_account,
    EXISTS(SELECT 1 FROM wallets WHERE purpose='login' AND address=? AND user_id=? AND chain_id<>?) AS wrong_chain,
    EXISTS(SELECT 1 FROM wallets WHERE purpose='customer' AND address=?) AS customer_relation,
    EXISTS(SELECT 1 FROM wallets WHERE purpose='payout' AND address=? AND org_id<>?) AS other_merchant`)
    .bind(address, userId, address, userId, TESTNET_CHAIN_ID, address, address, orgId)
    .first<WalletRelations>()
  return relations
}

function walletUnavailable(relations: WalletRelations | null): WalletUnavailableReason {
  return relations && (relations.other_account || relations.wrong_chain || relations.customer_relation || relations.other_merchant) ? 'wallet_in_use' : null
}

async function assertNoProtectedRelations(c: Context<WorkerContext>, address: string, userId: string, orgId: string) {
  if (walletUnavailable(await walletRelations(c, address, userId, orgId))) {
    throw conflict('This wallet is already associated with another account, customer, or merchant workspace', 'wallet_in_use')
  }
}

function activeOwnerSql() {
  return `EXISTS(SELECT 1 FROM sessions s
    JOIN users u ON u.id=s.user_id
    JOIN memberships m ON m.user_id=u.id AND m.org_id=?
    JOIN organizations o ON o.id=m.org_id
    JOIN privy_identities p ON p.user_id=u.id
    WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.idle_expires_at>?
      AND COALESCE(s.auth_provider,s.auth_method)='privy' AND u.status='active' AND m.role='owner' AND o.status='active')`
}

export function registerMerchantWalletRoutes(app: WorkerApp): void {
  app.get('/api/orgs/:orgId/merchant-wallet/status', async c => {
    const { auth, orgId } = await requirePrivyOwner(c)
    const parsed = addressBody.safeParse({ address: c.req.query('address') })
    if (!parsed.success) throw badRequest('A valid connected wallet is required')
    const address = normalizeAddress(parsed.data.address)
    const reason = walletUnavailable(await walletRelations(c, address, auth.userId, orgId))
    if (reason) return c.json({ verified: false, available: false, reason })
    const row = await c.env.DB.prepare(`SELECT EXISTS(
      SELECT 1 FROM wallets p JOIN wallets l ON l.purpose='login' AND l.user_id=? AND l.address=p.address AND l.chain_id=p.chain_id
      WHERE p.purpose='payout' AND p.org_id=? AND p.address=? AND p.chain_id=? AND p.verified_at IS NOT NULL AND p.verification_method='siwe'
        AND l.verified_at IS NOT NULL AND l.verification_method='siwe') AS verified`)
      .bind(auth.userId, orgId, address, TESTNET_CHAIN_ID)
      .first<{ verified: number }>()
    return c.json({ verified: Boolean(row?.verified), available: true, reason: null })
  })

  app.post('/api/orgs/:orgId/merchant-wallet/nonce', async c => {
    const { auth, orgId, now } = await requirePrivyOwner(c)
    const input = await readBody(c, addressBody)
    const address = normalizeAddress(input.address)
    await consumeRateLimit(c.env.DB, `merchant-wallet:challenge:user:${auth.userId}`, 12, 15 * 60_000)
    await consumeRateLimit(c.env.DB, `merchant-wallet:challenge:ip:${c.get('ip')}`, 30, 15 * 60_000)
    await assertNoProtectedRelations(c, address, auth.userId, orgId)

    const expiresAt = new Date(Date.parse(now) + CHALLENGE_TTL_MS).toISOString()
    const nonce = randomToken(24)
    const message = createSiweMessage({
      address: getAddress(address),
      chainId: TESTNET_CHAIN_ID,
      domain: c.env.SIWE_DOMAIN,
      uri: c.env.SIWE_URI,
      version: '1',
      statement: STATEMENT,
      nonce,
      issuedAt: new Date(now),
      expirationTime: new Date(expiresAt),
    })
    const inserted = await c.env.DB.prepare(`INSERT INTO merchant_wallet_challenges
      (id,nonce,org_id,user_id,session_id,address,chain_id,message_hash,expires_at)
      SELECT ?,?,?,?,?,?,?,?,?
      WHERE ${activeOwnerSql()}
      RETURNING id`)
      .bind(crypto.randomUUID(), nonce, orgId, auth.userId, auth.sessionId, address, TESTNET_CHAIN_ID, await sha256(message), expiresAt,
        orgId, auth.sessionId, auth.userId, now, now)
      .first<{ id: string }>()
    if (!inserted) throw forbidden('The active Privy owner session changed; reload and try again')
    return c.json({ message, expiresAt }, 201)
  })

  app.post('/api/orgs/:orgId/merchant-wallet/verify', async c => {
    const { auth, orgId, now } = await requirePrivyOwner(c)
    const input = await readBody(c, verifyBody)
    const { address, nonce } = checkSiweMessage(c, input.message, new Date(now), STATEMENT)
    let recovered: string
    try {
      recovered = (await recoverMessageAddress({ message: input.message, signature: input.signature as `0x${string}` })).toLowerCase()
    } catch {
      throw unauthorized('Invalid wallet signature')
    }
    if (recovered !== address) throw unauthorized('Signature does not match the requested merchant wallet')
    await assertNoProtectedRelations(c, address, auth.userId, orgId)

    const consumed = await c.env.DB.prepare(`UPDATE merchant_wallet_challenges SET used_at=?
      WHERE nonce=? AND org_id=? AND user_id=? AND session_id=? AND address=? AND chain_id=?
        AND message_hash=? AND expires_at>? AND used_at IS NULL
        AND ${activeOwnerSql()}
      RETURNING id`)
      .bind(now, nonce, orgId, auth.userId, auth.sessionId, address, TESTNET_CHAIN_ID, await sha256(input.message), now,
        orgId, auth.sessionId, auth.userId, now, now)
      .first<{ id: string }>()
    if (!consumed) {
      await assertNoProtectedRelations(c, address, auth.userId, orgId)
      throw unauthorized('Merchant wallet challenge is invalid, expired, already used, or belongs to a different session or organization')
    }

    await linkMerchantWalletToOwner(c, { address, userId: auth.userId }, auth.userId, orgId)
    const requireVerifiedEmail = c.env.REQUIRE_VERIFIED_EMAIL === undefined ? c.env.APP_ENV === 'production' : c.env.REQUIRE_VERIFIED_EMAIL === 'true'
    return c.json({ ...await loadWorkerAccount(c, auth.userId), session: { method: auth.method }, policy: { requireVerifiedEmail } })
  })
}
