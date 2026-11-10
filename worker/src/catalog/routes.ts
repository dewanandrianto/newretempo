import type { Context } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createOrm } from '../db/client'
import { organizations } from '../db/schema'
import type { ApiOrganization } from '../../../shared/types/api'
import type { WorkerApp, WorkerContext } from '../types'
import { requireWorkerAuth, requireWorkerOrg } from '../auth/guards'
import { loadWorkerAccount } from '../auth/account'
import { consumeRateLimit } from '../auth/rateLimits'
import { auditStatement } from '../audit'
import { newId, nowIso } from '../common'
import { conflict, forbidden, notFound } from '../errors'
import { registerResources } from './resources'
import { registerMembers } from './members'
import { registerAssociations } from './associations'
import { mutate } from './db'
import { badRequest } from '../errors'
import { readBody } from '../http'

type C = Context<WorkerContext>
const text = (max: number, min = 1) => z.string().trim().min(min).max(max)
const website = z.string().trim().max(200).refine(v => v === '' || /^https?:\/\/[^\s/]+\.[^\s]+$/.test(v), 'Start with https://').transform(v => v || null)
const orgBody = z.object({ name: text(80, 2), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Use 3-40 lowercase letters, numbers or hyphens'), website: website.optional(), industry: text(60), country: text(60) })
interface OrgRow { id: string; name: string; slug: string; website: string | null; industry: string; country: string; created_at: string }
const toOrg = (r: OrgRow): ApiOrganization => ({ id: r.id, name: r.name, slug: r.slug, website: r.website, industry: r.industry, country: r.country, createdAt: r.created_at })
async function getOrg(c: C, id: string) {
  const row = await createOrm(c.env.DB).select().from(organizations).where(eq(organizations.id, id)).get()
  if (!row) throw notFound('Organization')
  return toOrg(row)
}
export function registerCatalogRoutes(app: WorkerApp): void {
  registerResources(app)
  registerMembers(app)
  registerAssociations(app)
  app.patch('/api/orgs/:orgId', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'org:update')
    const patch = await readBody(c, z.object({ name: text(80, 2).optional(), website: website.optional(), industry: text(60).optional(), country: text(60).optional() }))
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (!entries.length) throw badRequest('Send at least one field to update')
    await mutate(c, c.env.DB.prepare(`UPDATE organizations SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE id=?`).bind(...entries.map(([, value]) => value!), nowIso(), orgId), auth.userId, orgId, 'organization.updated', 'organization', orgId, { fields: Object.keys(patch) })
    return c.json(await getOrg(c, orgId))
  })
  app.get('/api/orgs', async c => c.json((await loadWorkerAccount(c, requireWorkerAuth(c).userId)).memberships))
  app.post('/api/orgs', async c => {
    const auth = requireWorkerAuth(c)
    const input = await readBody(c, orgBody)
    const requireVerifiedEmail = c.env.REQUIRE_VERIFIED_EMAIL === undefined ? c.env.APP_ENV === 'production' : c.env.REQUIRE_VERIFIED_EMAIL === 'true'
    if (requireVerifiedEmail && auth.user.email && !auth.user.emailVerified) throw forbidden('Verify your email address before creating an organization')
    await consumeRateLimit(c.env.DB, `org:create:${auth.userId}`, 5, 86400000)
    const id = newId(), now = nowIso()
    try {
      await c.env.DB.batch([
        c.env.DB.prepare('INSERT INTO organizations (id,name,slug,website,industry,country,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, input.name, input.slug, input.website ?? null, input.industry, input.country, auth.userId, now, now),
        c.env.DB.prepare("INSERT INTO memberships (id,org_id,user_id,role,created_at) VALUES (?,?,?,'owner',?)").bind(newId(), id, auth.userId, now),
        auditStatement(c, { orgId: id, actorUserId: auth.userId, action: 'organization.created', resourceType: 'organization', resourceId: id, metadata: { slug: input.slug } }),
      ])
    } catch (error) {
      if (String(error).includes('UNIQUE') && String(error).includes('slug')) throw conflict('That organization URL is taken', 'slug_taken')
      throw error
    }
    return c.json(await getOrg(c, id), 201)
  })
  app.get('/api/orgs/:orgId', async c => c.json(await getOrg(c, (await requireWorkerOrg(c, 'org:read')).orgId)))
}
