import type { Context } from 'hono'
import type { WorkerContext } from './types'
import { newId, nowIso } from './common'

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
export function scrubMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubMetadata(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : scrubMetadata(item, depth + 1)]))
  }
  return typeof value === 'bigint' ? value.toString() : value
}
/** Always batch this statement with the mutation; do not write a detached success audit. */
export function auditStatement(c: Context<WorkerContext>, event: AuditEvent): D1PreparedStatement {
  return c.env.DB.prepare(`INSERT INTO audit_logs
    (id, org_id, actor_user_id, actor_type, action, resource_type, resource_id, metadata, ip, user_agent, request_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId(), event.orgId ?? null, event.actorUserId ?? null, event.actorType ?? 'user',
      event.action, event.resourceType, event.resourceId ?? null, JSON.stringify(scrubMetadata(event.metadata ?? {})),
      c.get('ip') ?? null, c.req.header('User-Agent')?.slice(0, 300) ?? null, c.get('requestId') ?? null, nowIso())
}
