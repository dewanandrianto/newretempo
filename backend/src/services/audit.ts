import type { Db } from '../db/client'
import type { Ctx } from '../http/types'

export interface AuditEvent {
  orgId?: string | null
  actorUserId?: string | null
  actorType?: 'user' | 'system' | 'api_key' | 'chain'
  action: string
  resourceType: string
  resourceId?: string | null
  metadata?: Record<string, unknown>
}

const SECRET_KEY = /pass(word)?|token|secret|signature|(password|key|token)_?hash|cookie|authorization|private/i

/** Drops anything that looks like a credential before it can reach the audit trail. */
export function scrubMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubMetadata(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : scrubMetadata(v, depth + 1)
    }
    return out
  }
  return typeof value === 'bigint' ? value.toString() : value
}

/** Appends an audit row. Pass the transaction handle so the entry commits with the change it describes. */
export async function audit(db: Db, ctx: Pick<Ctx, 'ip' | 'requestId' | 'req'> | null, event: AuditEvent): Promise<void> {
  const metadata = JSON.stringify(scrubMetadata(event.metadata ?? {}))
  const ua = ctx?.req.headers.get('user-agent')?.slice(0, 300) ?? null
  await db`
    INSERT INTO audit_logs (org_id, actor_user_id, actor_type, action, resource_type, resource_id, metadata, ip, user_agent, request_id)
    VALUES (${event.orgId ?? null}, ${event.actorUserId ?? null}, ${event.actorType ?? 'user'}, ${event.action},
            ${event.resourceType}, ${event.resourceId ?? null}, (${metadata}::text)::jsonb,
            ${ctx?.ip ?? null}, ${ua}, ${ctx?.requestId ?? null})`
}
