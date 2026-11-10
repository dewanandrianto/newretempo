import { z } from 'zod'
import type { ApiAuditLog, ApiKeyCreated, ApiKeyRecord } from '@shared/types'
import { withTx } from '../db/client'
import { notFound } from '../http/errors'
import type { Ctx } from '../http/types'
import { hmacHex, randomNonce, randomToken } from '../security/crypto'
import { audit } from './audit'
import { iso, shortText } from './common'

export const apiKeyBody = z.object({
  name: shortText(80),
  scopes: z.array(z.enum(['read', 'write'])).min(1).max(2).default(['read']),
  expiresInDays: z.number().int().min(1).max(365).optional(),
})

interface Row {
  id: string
  name: string
  prefix: string
  scopes: string[]
  created_at: Date
  last_used_at: Date | null
  expires_at: Date | null
  revoked_at: Date | null
}
const toKey = (r: Row): ApiKeyRecord => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  createdAt: iso(r.created_at) ?? '',
  lastUsedAt: iso(r.last_used_at),
  expiresAt: iso(r.expires_at),
  revokedAt: iso(r.revoked_at),
})

export async function listApiKeys(ctx: Ctx, orgId: string): Promise<ApiKeyRecord[]> {
  const rows = (await ctx.deps.db`
    SELECT id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at
    FROM api_keys WHERE org_id = ${orgId} ORDER BY created_at DESC`) as Row[]
  return rows.map(toKey)
}

/**
 * Issues a key. The full secret is returned once and only a keyed hash is stored, so a
 * database leak does not reveal usable keys. (Authenticating requests with these keys is not
 * wired up in Phase 2; the keys are issued, hashed, listed and revocable.)
 */
export async function createApiKey(ctx: Ctx, orgId: string, actorId: string, input: z.infer<typeof apiKeyBody>): Promise<ApiKeyCreated> {
  const prefix = `rtk_test_${randomNonce(10)}`
  const secret = `${prefix}.${randomToken(32)}`
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString() : null
  const id = await withTx(ctx.deps.db, async (tx) => {
    const rows = (await tx`
      INSERT INTO api_keys (org_id, created_by, name, prefix, key_hash, scopes, expires_at)
      VALUES (${orgId}, ${actorId}, ${input.name}, ${prefix}, ${hmacHex(ctx.deps.config.sessionSecret, secret)},
              ${`{${input.scopes.join(',')}}`}::text[], ${expiresAt}::timestamptz)
      RETURNING id`) as { id: string }[]
    await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'api_key.created', resourceType: 'api_key', resourceId: rows[0].id, metadata: { prefix, scopes: input.scopes } })
    return rows[0].id
  })
  const key = (await listApiKeys(ctx, orgId)).find((k) => k.id === id) as ApiKeyRecord
  return { ...key, secret }
}

export async function revokeApiKey(ctx: Ctx, orgId: string, actorId: string, id: string): Promise<void> {
  await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`UPDATE api_keys SET revoked_at = now() WHERE org_id = ${orgId} AND id = ${id} AND revoked_at IS NULL RETURNING id`
    if (!rows.length) throw notFound('API key')
    await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'api_key.revoked', resourceType: 'api_key', resourceId: id })
  })
}

export async function listAuditLogs(ctx: Ctx, orgId: string, limit: number, offset: number): Promise<ApiAuditLog[]> {
  const rows = (await ctx.deps.db`
    SELECT id, action, resource_type, resource_id, actor_user_id, actor_type, metadata, created_at
    FROM audit_logs WHERE org_id = ${orgId} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`) as {
    id: string
    action: string
    resource_type: string
    resource_id: string | null
    actor_user_id: string | null
    actor_type: ApiAuditLog['actorType']
    metadata: Record<string, unknown>
    created_at: Date
  }[]
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    actorUserId: r.actor_user_id,
    actorType: r.actor_type,
    metadata: r.metadata,
    createdAt: iso(r.created_at) ?? '',
  }))
}
