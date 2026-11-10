import type { Context } from 'hono'
import type { WorkerContext } from '../types'
import { forbidden, notFound, unauthorized } from '../errors'
import { can, type Permission, type OrgRole } from './permissions'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(value: string): boolean { return UUID.test(value) }
export function requireWorkerAuth(c: Context<WorkerContext>) {
  const auth = c.get('auth')
  if (!auth) throw unauthorized()
  return auth
}
export async function requireWorkerOrg(c: Context<WorkerContext>, permission: Permission) {
  const auth = requireWorkerAuth(c), orgId = c.req.param('orgId')
  if (!orgId || !isUuid(orgId)) throw notFound('Organization')
  const row = await c.env.DB.prepare("SELECT m.role FROM memberships m JOIN organizations o ON o.id=m.org_id JOIN users u ON u.id=m.user_id WHERE m.org_id=? AND m.user_id=? AND o.status='active' AND (o.created_by=u.id OR (u.email IS NOT NULL AND u.email_verified_at IS NOT NULL))").bind(orgId, auth.userId).first<{role: OrgRole}>()
  if (!row) throw notFound('Organization')
  if (!can(row.role, permission)) throw forbidden('Your role does not allow this action')
  return { orgId, role: row.role, auth }
}
export function resourceId(c: Context<WorkerContext>, name = 'id'): string {
  const id = c.req.param(name)
  if (!id || !isUuid(id)) throw notFound()
  return id
}
