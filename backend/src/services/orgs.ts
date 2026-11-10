import { z } from 'zod'
import type { ApiOrganization } from '@shared/types'
import { PG, pgCode, pgConstraint, withTx } from '../db/client'
import { conflict, forbidden } from '../http/errors'
import type { AuthContext, Ctx } from '../http/types'
import { audit } from './audit'
import { assertSomeUpdate, iso, shortText } from './common'

const website = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v === '' || /^https?:\/\/[^\s/]+\.[^\s]+$/.test(v), 'Start with https://')
  .transform((v) => (v === '' ? null : v))

export const createOrgBody = z.object({
  name: shortText(80, 2),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Use 3-40 lowercase letters, numbers or hyphens'),
  website: website.optional(),
  industry: shortText(60),
  country: shortText(60),
})

export const updateOrgBody = z.object({
  name: shortText(80, 2).optional(),
  website: website.optional(),
  industry: shortText(60).optional(),
  country: shortText(60).optional(),
})

interface OrgRow {
  id: string
  name: string
  slug: string
  website: string | null
  industry: string
  country: string
  created_at: Date
}

const toOrg = (r: OrgRow): ApiOrganization => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  website: r.website,
  industry: r.industry,
  country: r.country,
  createdAt: iso(r.created_at) ?? '',
})

export async function createOrganization(ctx: Ctx, auth: AuthContext, input: z.infer<typeof createOrgBody>): Promise<ApiOrganization> {
  const { db, config, limiter } = ctx.deps
  // Merchant onboarding requires a verified email when the server is configured for it.
  if (config.requireVerifiedEmail && auth.user.email && !auth.user.emailVerified) {
    throw forbidden('Verify your email address before creating an organization')
  }
  limiter.consume(`org:create:${auth.userId}`, 5, 24 * 3_600_000)
  try {
    return await withTx(db, async (tx) => {
      const rows = (await tx`
        INSERT INTO organizations (name, slug, website, industry, country, created_by)
        VALUES (${input.name}, ${input.slug}, ${input.website ?? null}, ${input.industry}, ${input.country}, ${auth.userId})
        RETURNING id, name, slug, website, industry, country, created_at`) as OrgRow[]
      const org = rows[0]
      await tx`INSERT INTO memberships (org_id, user_id, role) VALUES (${org.id}, ${auth.userId}, 'owner')`
      await audit(tx, ctx, { orgId: org.id, actorUserId: auth.userId, action: 'organization.created', resourceType: 'organization', resourceId: org.id, metadata: { slug: org.slug } })
      return toOrg(org)
    })
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation && (pgConstraint(err) ?? '').includes('slug')) {
      throw conflict('That organization URL is taken', 'slug_taken')
    }
    throw err
  }
}

export async function getOrganization(ctx: Ctx, orgId: string): Promise<ApiOrganization> {
  const rows = (await ctx.deps.db`
    SELECT id, name, slug, website, industry, country, created_at FROM organizations WHERE id = ${orgId}`) as OrgRow[]
  return toOrg(rows[0])
}

export async function updateOrganization(ctx: Ctx, orgId: string, actorId: string, patch: z.infer<typeof updateOrgBody>): Promise<ApiOrganization> {
  assertSomeUpdate(patch)
  const { db } = ctx.deps
  return withTx(db, async (tx) => {
    const rows = (await tx`
      UPDATE organizations SET
        name = COALESCE(${patch.name ?? null}::text, name),
        website = CASE WHEN ${patch.website !== undefined}::bool THEN ${patch.website ?? null}::text ELSE website END,
        industry = COALESCE(${patch.industry ?? null}::text, industry),
        country = COALESCE(${patch.country ?? null}::text, country)
      WHERE id = ${orgId}
      RETURNING id, name, slug, website, industry, country, created_at`) as OrgRow[]
    await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'organization.updated', resourceType: 'organization', resourceId: orgId, metadata: { fields: Object.keys(patch) } })
    return toOrg(rows[0])
  })
}
