import { z } from 'zod'
import type { ApiMember, OrgRole } from '@shared/types'
import { outranks } from '../auth/permissions'
import { PG, pgCode, withTx } from '../db/client'
import { conflict, forbidden, notFound } from '../http/errors'
import type { Ctx } from '../http/types'
import { audit } from './audit'
import { iso } from './common'

export const addMemberBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: z.enum(['admin', 'member']),
})
export const updateMemberBody = z.object({ role: z.enum(['owner', 'admin', 'member']) })

interface MemberRow {
  user_id: string
  email: string | null
  display_name: string
  role: OrgRole
  created_at: Date
}
const toMember = (r: MemberRow): ApiMember => ({
  userId: r.user_id,
  email: r.email,
  displayName: r.display_name,
  role: r.role,
  createdAt: iso(r.created_at) ?? '',
})

export async function listMembers(ctx: Ctx, orgId: string): Promise<ApiMember[]> {
  const rows = (await ctx.deps.db`
    SELECT m.user_id, u.email, u.display_name, m.role, m.created_at
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ${orgId} ORDER BY m.created_at`) as MemberRow[]
  return rows.map(toMember)
}

async function roleOf(ctx: Ctx, orgId: string, userId: string): Promise<OrgRole | null> {
  const rows = (await ctx.deps.db`SELECT role FROM memberships WHERE org_id = ${orgId} AND user_id = ${userId}`) as { role: OrgRole }[]
  return rows[0]?.role ?? null
}

/** Adds an existing RETEMPO account. Email invitations for new users arrive with a mail provider. */
export async function addMember(ctx: Ctx, orgId: string, actor: { id: string; role: OrgRole }, input: z.infer<typeof addMemberBody>): Promise<ApiMember> {
  if (!outranks(actor.role, input.role)) throw forbidden('You can only add members with a lower role than yours')
  const { db } = ctx.deps
  const users = (await db`SELECT id FROM users WHERE email = ${input.email} AND status = 'active'`) as { id: string }[]
  if (!users[0]) throw notFound('RETEMPO account with that email')
  try {
    await withTx(db, async (tx) => {
      await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${users[0].id}, ${input.role})`
      await audit(tx, ctx, { orgId, actorUserId: actor.id, action: 'member.added', resourceType: 'membership', resourceId: users[0].id, metadata: { role: input.role } })
    })
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('That person is already a member', 'already_member')
    throw err
  }
  return (await listMembers(ctx, orgId)).find((m) => m.userId === users[0].id) as ApiMember
}

export async function changeMemberRole(ctx: Ctx, orgId: string, actor: { id: string; role: OrgRole }, targetId: string, role: OrgRole): Promise<ApiMember> {
  const current = await roleOf(ctx, orgId, targetId)
  if (!current) throw notFound('Member')
  // Actors may only touch people below them and may only grant roles below their own.
  if (!outranks(actor.role, current) || !outranks(actor.role, role)) throw forbidden('You cannot change this member to that role')
  await withTx(ctx.deps.db, async (tx) => {
    await tx`UPDATE memberships SET role = ${role} WHERE org_id = ${orgId} AND user_id = ${targetId}`
    await audit(tx, ctx, { orgId, actorUserId: actor.id, action: 'member.role_changed', resourceType: 'membership', resourceId: targetId, metadata: { from: current, to: role } })
  })
  return (await listMembers(ctx, orgId)).find((m) => m.userId === targetId) as ApiMember
}

export async function removeMember(ctx: Ctx, orgId: string, actor: { id: string; role: OrgRole }, targetId: string): Promise<void> {
  const current = await roleOf(ctx, orgId, targetId)
  if (!current) throw notFound('Member')
  const leavingSelf = targetId === actor.id
  if (!leavingSelf && !outranks(actor.role, current)) throw forbidden('You cannot remove this member')
  try {
    await withTx(ctx.deps.db, async (tx) => {
      await tx`DELETE FROM memberships WHERE org_id = ${orgId} AND user_id = ${targetId}`
      await audit(tx, ctx, { orgId, actorUserId: actor.id, action: leavingSelf ? 'member.left' : 'member.removed', resourceType: 'membership', resourceId: targetId })
    })
  } catch (err) {
    if (pgCode(err) === PG.checkViolation) throw conflict('An organization must keep at least one owner', 'last_owner')
    throw err
  }
}
