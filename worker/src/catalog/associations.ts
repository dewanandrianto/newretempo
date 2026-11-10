import { z } from 'zod'
import type { Context } from 'hono'
import type { ApiWallet, ApiKeyRecord, ApiKeyCreated, ApiAuditLog } from '../../../shared/types/api'
import type { WorkerApp, WorkerContext } from '../types'
import { requireWorkerOrg, resourceId } from '../auth/guards'
import { hmac, randomToken } from '../auth/crypto'
import { newId, nowIso, evmAddress, uuid, shortText } from '../common'
import { notFound, unavailable, validationFailed } from '../errors'
import { readBody } from '../http'
import { insert, update, mutate, mapConstraint } from './db'

type C = Context<WorkerContext>
const walletBody = z.object({ purpose: z.enum(['payout', 'customer']), address: evmAddress, label: z.string().trim().max(80).default(''), customerId: uuid.optional() })
const walletPatch = z.object({ label: z.string().trim().max(80) })
const keyBody = z.object({ name: shortText(80), scopes: z.array(z.enum(['read', 'write'])).min(1).max(2).default(['read']), expiresInDays: z.number().int().min(1).max(365).optional() })
interface WalletRow { id: string; purpose: ApiWallet['purpose']; address: string; chain_id: number; label: string; customer_id: string | null; verified_at: string | null; created_at: string }
interface KeyRow { id: string; name: string; prefix: string; scopes: string; created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null }
interface AuditRow { id: string; action: string; resource_type: string; resource_id: string | null; actor_user_id: string | null; actor_type: ApiAuditLog['actorType']; metadata: string; created_at: string }
const toWallet = (r: WalletRow): ApiWallet => ({ id: r.id, purpose: r.purpose, address: r.address, chainId: r.chain_id, label: r.label, customerId: r.customer_id, verified: r.verified_at !== null, createdAt: r.created_at })
const toKey = (r: KeyRow): ApiKeyRecord => ({ id: r.id, name: r.name, prefix: r.prefix, scopes: JSON.parse(r.scopes) as string[], createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at, revokedAt: r.revoked_at })
async function wallet(c: C, org: string, id: string) { const row = await c.env.DB.prepare("SELECT * FROM wallets WHERE org_id=? AND id=? AND purpose IN ('payout','customer')").bind(org, id).first<WalletRow>(); if (!row) throw notFound('Wallet'); return toWallet(row) }
async function key(c: C, org: string, id: string) { const row = await c.env.DB.prepare('SELECT id,name,prefix,scopes,created_at,last_used_at,expires_at,revoked_at FROM api_keys WHERE org_id=? AND id=?').bind(org, id).first<KeyRow>(); if (!row) throw notFound('API key'); return toKey(row) }
export function registerAssociations(app: WorkerApp) {
  app.get('/api/orgs/:orgId/wallets', async c => {
    const { orgId } = await requireWorkerOrg(c, 'org:read')
    return c.json((await c.env.DB.prepare("SELECT * FROM wallets WHERE org_id=? AND purpose IN ('payout','customer') ORDER BY created_at DESC").bind(orgId).all<WalletRow>()).results.map(toWallet))
  })
  app.post('/api/orgs/:orgId/wallets', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'wallets:write'), input = await readBody(c, walletBody), id = newId(), now = nowIso()
    if (input.purpose === 'customer' && !input.customerId) throw validationFailed({ customerId: 'Choose the customer this wallet belongs to' })
    if (input.purpose === 'payout' && input.customerId) throw validationFailed({ customerId: 'Payout wallets belong to the organization' })
    if (input.customerId && !await c.env.DB.prepare('SELECT id FROM customers WHERE org_id=? AND id=?').bind(orgId, input.customerId).first()) throw notFound('Customer')
    try { await insert(c, 'wallets', { id, org_id: orgId, purpose: input.purpose, address: input.address, label: input.label, customer_id: input.customerId ?? null, chain_id: Number(c.env.SIWE_CHAIN_ID), created_at: now, updated_at: now }, auth.userId, orgId, 'wallet.associated', 'wallet', id, { purpose: input.purpose, address: input.address, verified: false }) }
    catch (e) { mapConstraint(e, 'This wallet is already associated', 'duplicate_wallet') }
    return c.json(await wallet(c, orgId, id), 201)
  })
  app.patch('/api/orgs/:orgId/wallets/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'wallets:write'), id = resourceId(c), patch = await readBody(c, walletPatch)
    await wallet(c, orgId, id)
    await update(c, 'wallets', orgId, id, patch, auth.userId, 'wallet', false)
    return c.json(await wallet(c, orgId, id))
  })
  app.delete('/api/orgs/:orgId/wallets/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'wallets:write'), id = resourceId(c)
    await mutate(c, c.env.DB.prepare("DELETE FROM wallets WHERE org_id=? AND id=? AND purpose IN ('payout','customer')").bind(orgId, id), auth.userId, orgId, 'wallet.removed', 'wallet', id)
    return c.body(null, 204)
  })
  app.get('/api/orgs/:orgId/api-keys', async c => {
    const { orgId } = await requireWorkerOrg(c, 'api_keys:manage')
    return c.json((await c.env.DB.prepare('SELECT id,name,prefix,scopes,created_at,last_used_at,expires_at,revoked_at FROM api_keys WHERE org_id=? ORDER BY created_at DESC').bind(orgId).all<KeyRow>()).results.map(toKey))
  })
  // Records only: API-key authentication is deliberately not registered by this module.
  app.post('/api/orgs/:orgId/api-keys', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'api_keys:manage')
    if (c.env.APP_ENV === 'production') throw unavailable('API-key authentication is not implemented; production API credentials cannot be issued', 'api_key_auth_unavailable')
    const input = await readBody(c, keyBody), id = newId(), now = nowIso()
    const prefix = `rtk_test_${randomToken(10)}`, secret = `${prefix}.${randomToken(32)}`
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400000).toISOString() : null
    await insert(c, 'api_keys', { id, org_id: orgId, created_by: auth.userId, name: input.name, prefix, key_hash: await hmac(c.env.SESSION_SECRET, secret), scopes: JSON.stringify(input.scopes), expires_at: expiresAt, created_at: now, updated_at: now }, auth.userId, orgId, 'api_key.created', 'api_key', id, { prefix, scopes: input.scopes })
    const result: ApiKeyCreated = { ...await key(c, orgId, id), secret }
    return c.json(result, 201)
  })
  app.delete('/api/orgs/:orgId/api-keys/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'api_keys:manage'), id = resourceId(c)
    await mutate(c, c.env.DB.prepare('UPDATE api_keys SET revoked_at=?,updated_at=? WHERE org_id=? AND id=? AND revoked_at IS NULL').bind(nowIso(), nowIso(), orgId, id), auth.userId, orgId, 'api_key.revoked', 'api_key', id)
    return c.body(null, 204)
  })
  app.get('/api/orgs/:orgId/audit-logs', async c => {
    const { orgId } = await requireWorkerOrg(c, 'api_keys:manage')
    const page = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(c.req.query())
    const rows = await c.env.DB.prepare('SELECT id,action,resource_type,resource_id,actor_user_id,actor_type,metadata,created_at FROM audit_logs WHERE org_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(orgId, page.limit, page.offset).all<AuditRow>()
    return c.json(rows.results.map((r): ApiAuditLog => ({ id: r.id, action: r.action, resourceType: r.resource_type, resourceId: r.resource_id, actorUserId: r.actor_user_id, actorType: r.actor_type, metadata: JSON.parse(r.metadata) as Record<string, unknown>, createdAt: r.created_at })))
  })
}
