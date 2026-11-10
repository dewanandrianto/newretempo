import { z } from 'zod'
import type { Context } from 'hono'
import type { ApiMember, OrgRole } from '../../../shared/types/api'
import type { WorkerApp, WorkerContext } from '../types'
import { requireWorkerOrg, resourceId } from '../auth/guards'
import { nowIso, newId } from '../common'
import { readBody } from '../http'
import { conflict, forbidden, notFound } from '../errors'
import { mutate, mapConstraint } from './db'

type C = Context<WorkerContext>
const ranks: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1 }
const addBody = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()), role: z.enum(['admin', 'member']) })
const changeBody = z.object({ role: z.enum(['owner', 'admin', 'member']) })
interface MemberRow { user_id: string; email: string | null; display_name: string; role: OrgRole; created_at: string }
const toMember = (r: MemberRow): ApiMember => ({ userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role, createdAt: r.created_at })
async function members(c: C, orgId: string) {
  return (await c.env.DB.prepare('SELECT m.user_id,u.email,u.display_name,m.role,m.created_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=? ORDER BY m.created_at').bind(orgId).all<MemberRow>()).results.map(toMember)
}
export function registerMembers(app: WorkerApp) {
  app.get('/api/orgs/:orgId/members', async c => c.json(await members(c, (await requireWorkerOrg(c, 'members:read')).orgId)))
  app.post('/api/orgs/:orgId/members', async c => {
    const { orgId, auth, role } = await requireWorkerOrg(c, 'members:manage'), input = await readBody(c, addBody)
    if (ranks[role] <= ranks[input.role]) throw forbidden('You can only add members with a lower role than yours')
    const user = await c.env.DB.prepare("SELECT id FROM users WHERE email=? AND status='active' AND email_verified_at IS NOT NULL").bind(input.email).first<{ id: string }>()
    if (!user) throw notFound('RETEMPO account with that email')
    try { await mutate(c, c.env.DB.prepare("INSERT INTO memberships (id,org_id,user_id,role,created_at) SELECT ?,?,?,?,? FROM users WHERE id=? AND email=? AND status='active' AND email_verified_at IS NOT NULL").bind(newId(), orgId, user.id, input.role, nowIso(), user.id, input.email), auth.userId, orgId, 'member.added', 'membership', user.id, { role: input.role }) }
    catch (e) { mapConstraint(e, 'That person is already a member', 'already_member') }
    return c.json((await members(c, orgId)).find(m => m.userId === user.id)!, 201)
  })
  app.patch('/api/orgs/:orgId/members/:userId', async c => {
    const { orgId, auth, role } = await requireWorkerOrg(c, 'members:manage'), target = resourceId(c, 'userId'), input = await readBody(c, changeBody)
    const current = await c.env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_id=?').bind(orgId, target).first<{ role: OrgRole }>()
    if (!current) throw notFound('Member')
    if (ranks[role] <= ranks[current.role] || ranks[role] <= ranks[input.role]) throw forbidden('You cannot change this member to that role')
    await mutate(c, c.env.DB.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').bind(input.role, orgId, target), auth.userId, orgId, 'member.role_changed', 'membership', target, { from: current.role, to: input.role })
    return c.json((await members(c, orgId)).find(m => m.userId === target)!)
  })
  app.delete('/api/orgs/:orgId/members/:userId', async c => {
    const { orgId, auth, role } = await requireWorkerOrg(c, 'org:read'), target = resourceId(c, 'userId'), self = target === auth.userId
    if (!self) await requireWorkerOrg(c, 'members:manage')
    const current = await c.env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_id=?').bind(orgId, target).first<{ role: OrgRole }>()
    if (!current) throw notFound('Member')
    if (!self && ranks[role] <= ranks[current.role]) throw forbidden('You cannot remove this member')
    try { await mutate(c, c.env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_id=?').bind(orgId, target), auth.userId, orgId, self ? 'member.left' : 'member.removed', 'membership', target) }
    catch (e) { if (/last.owner|at least one owner/i.test(String(e))) throw conflict('An organization must keep at least one owner', 'last_owner'); throw e }
    return c.body(null, 204)
  })
}
