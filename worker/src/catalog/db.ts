import type { Context } from 'hono'
import type { WorkerContext } from '../types'
import { auditStatement } from '../audit'
import { conflict, badRequest, notFound } from '../errors'
import { nowIso } from '../common'

type C = Context<WorkerContext>
export type Values = Record<string, string | number | null>
export async function insert(c: C, table: string, values: Values, actor: string, orgId: string, action: string, type: string, id: string, metadata?: Record<string, unknown>) {
  const columns = Object.keys(values)
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...Object.values(values)),
    auditStatement(c, { orgId, actorUserId: actor, action, resourceType: type, resourceId: id, metadata }),
  ])
}
/** Audit is conditional on the immediately preceding mutation, inside the same D1 transaction. */
export async function mutate(c: C, statement: D1PreparedStatement, actor: string, orgId: string, action: string, type: string, id: string, metadata?: Record<string, unknown>) {
  // Preflight existence checks are made by the caller, while the SQL retains its tenant predicate.
  // The batch aborts on zero affected rows using a check assertion, preventing phantom audit rows.
  try {
    await c.env.DB.batch([
      statement,
      c.env.DB.prepare("SELECT CASE WHEN changes() = 0 THEN json('catalog_missing_mutation') ELSE 1 END"),
      auditStatement(c, { orgId, actorUserId: actor, action, resourceType: type, resourceId: id, metadata }),
    ])
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      const label = type === 'api_key' ? 'API key' : type === 'membership' ? 'Member' : type[0].toUpperCase() + type.slice(1)
      throw notFound(label)
    }
    throw error
  }
}
export async function update(c: C, table: string, orgId: string, id: string, patch: Values, actor: string, type: string, metadata = true) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined)
  if (!entries.length) throw badRequest('Send at least one field to update')
  const exists = await c.env.DB.prepare(`SELECT id FROM ${table} WHERE org_id=? AND id=?`).bind(orgId, id).first()
  if (!exists) throw notFound(type[0].toUpperCase() + type.slice(1))
  await mutate(c, c.env.DB.prepare(`UPDATE ${table} SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE org_id=? AND id=?`).bind(...entries.map(([, v]) => v), nowIso(), orgId, id), actor, orgId, `${type}.updated`, type, id, metadata ? { fields: Object.keys(patch).map(k => k.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())) } : undefined)
}
export function mapConstraint(error: unknown, duplicate: string, code: string, inUse?: string): never {
  const message = String(error)
  if (message.includes('UNIQUE constraint')) throw conflict(duplicate, code)
  if (message.includes('FOREIGN KEY constraint') && inUse) throw conflict(inUse, 'in_use')
  throw error
}
