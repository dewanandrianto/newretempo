import { can, type Permission } from '../auth/permissions'
import { forbidden, notFound, unauthorized } from './errors'
import type { AuthContext, Ctx, OrgRole } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID.test(value)
}

export function requireAuth(ctx: Ctx): AuthContext {
  if (!ctx.auth) throw unauthorized()
  return ctx.auth
}

export interface OrgAccess {
  orgId: string
  role: OrgRole
  auth: AuthContext
}

/**
 * The single gate for every merchant endpoint.
 * The organization id in the URL is never trusted: it is only honoured if the signed-in
 * user holds a membership in it. Non-members get 404, so other tenants' ids reveal nothing.
 * Handlers must use the returned `orgId` in every query.
 */
export async function requireOrg(ctx: Ctx, permission: Permission): Promise<OrgAccess> {
  const auth = requireAuth(ctx)
  const orgId = ctx.params.orgId
  if (!orgId || !isUuid(orgId)) throw notFound('Organization')
  const rows = (await ctx.deps.db`
    SELECT m.role FROM memberships m
    JOIN organizations o ON o.id = m.org_id
    WHERE m.org_id = ${orgId} AND m.user_id = ${auth.userId} AND o.status = 'active'`) as { role: OrgRole }[]
  const role = rows[0]?.role
  if (!role) throw notFound('Organization')
  if (!can(role, permission)) throw forbidden('Your role does not allow this action')
  return { orgId, role, auth }
}

/** Resource ids from the URL must be well-formed UUIDs before they reach SQL. */
export function resourceId(ctx: Ctx, name = 'id'): string {
  const id = ctx.params[name]
  if (!id || !isUuid(id)) throw notFound()
  return id
}
