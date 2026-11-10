import { z } from 'zod'
import type { ApiPlan, ApiProduct } from '@shared/types'
import { PG, pgCode, withTx } from '../db/client'
import { conflict, notFound } from '../http/errors'
import type { Ctx } from '../http/types'
import { audit } from './audit'
import { assertSomeUpdate, iso, positiveBaseUnits, shortText, uuid, type Page } from './common'

export const productBody = z.object({
  name: shortText(120),
  description: z.string().trim().max(1000).default(''),
})
export const productPatch = z.object({
  name: shortText(120).optional(),
  description: z.string().trim().max(1000).optional(),
  status: z.enum(['active', 'archived']).optional(),
})

const interval = z.enum(['week', 'month', 'year'])
export const planBody = z.object({
  productId: uuid,
  name: shortText(120),
  amount: positiveBaseUnits,
  interval,
  trialDays: z.number().int().min(0).max(365).default(0),
  escrowDays: z.number().int().min(0).max(90).default(0),
})
export const planPatch = z.object({
  name: shortText(120).optional(),
  amount: positiveBaseUnits.optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  escrowDays: z.number().int().min(0).max(90).optional(),
  status: z.enum(['active', 'archived']).optional(),
})

interface ProductRow {
  id: string
  name: string
  description: string
  status: 'active' | 'archived'
  plan_count: string | number
  created_at: Date
  updated_at: Date
}
const toProduct = (r: ProductRow): ApiProduct => ({
  id: r.id,
  name: r.name,
  description: r.description,
  status: r.status,
  planCount: Number(r.plan_count),
  createdAt: iso(r.created_at) ?? '',
  updatedAt: iso(r.updated_at) ?? '',
})

export async function listProducts(ctx: Ctx, orgId: string, page: Page): Promise<ApiProduct[]> {
  const rows = (await ctx.deps.db`
    SELECT p.id, p.name, p.description, p.status, p.created_at, p.updated_at,
           (SELECT count(*) FROM plans pl WHERE pl.org_id = p.org_id AND pl.product_id = p.id) AS plan_count
    FROM products p WHERE p.org_id = ${orgId}
    ORDER BY p.created_at DESC LIMIT ${page.limit} OFFSET ${page.offset}`) as ProductRow[]
  return rows.map(toProduct)
}

export async function getProduct(ctx: Ctx, orgId: string, id: string): Promise<ApiProduct> {
  const rows = (await ctx.deps.db`
    SELECT p.id, p.name, p.description, p.status, p.created_at, p.updated_at,
           (SELECT count(*) FROM plans pl WHERE pl.org_id = p.org_id AND pl.product_id = p.id) AS plan_count
    FROM products p WHERE p.org_id = ${orgId} AND p.id = ${id}`) as ProductRow[]
  if (!rows[0]) throw notFound('Product')
  return toProduct(rows[0])
}
export async function createProduct(ctx: Ctx, orgId: string, actorId: string, input: z.infer<typeof productBody>): Promise<ApiProduct> {
  try {
    const id = await withTx(ctx.deps.db, async (tx) => {
      const rows = (await tx`
        INSERT INTO products (org_id, name, description) VALUES (${orgId}, ${input.name}, ${input.description})
        RETURNING id`) as { id: string }[]
      await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'product.created', resourceType: 'product', resourceId: rows[0].id })
      return rows[0].id
    })
    return await getProduct(ctx, orgId, id)
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('A product with this name already exists', 'duplicate_name')
    throw err
  }
}

export async function updateProduct(ctx: Ctx, orgId: string, actorId: string, id: string, patch: z.infer<typeof productPatch>): Promise<ApiProduct> {
  assertSomeUpdate(patch)
  try {
    const n = await withTx(ctx.deps.db, async (tx) => {
      const rows = await tx`
        UPDATE products SET name = COALESCE(${patch.name ?? null}::text, name),
                            description = COALESCE(${patch.description ?? null}::text, description),
                            status = COALESCE(${patch.status ?? null}::text, status)
        WHERE org_id = ${orgId} AND id = ${id} RETURNING id`
      if (rows.length) await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'product.updated', resourceType: 'product', resourceId: id, metadata: { fields: Object.keys(patch) } })
      return rows.length
    })
    if (!n) throw notFound('Product')
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('A product with this name already exists', 'duplicate_name')
    throw err
  }
  return getProduct(ctx, orgId, id)
}

export async function deleteProduct(ctx: Ctx, orgId: string, actorId: string, id: string): Promise<void> {
  await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`DELETE FROM products WHERE org_id = ${orgId} AND id = ${id} RETURNING id`
    if (!rows.length) throw notFound('Product')
    await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'product.deleted', resourceType: 'product', resourceId: id })
  }).catch((err: unknown) => {
    if (pgCode(err) === PG.foreignKeyViolation) throw conflict('Archive this product instead: it still has plans', 'in_use')
    throw err
  })
}

// ---- plans ------------------------------------------------------------------

interface PlanRow {
  id: string
  product_id: string
  product_name: string
  name: string
  amount: string
  interval: 'week' | 'month' | 'year'
  trial_days: number
  escrow_days: number
  status: 'active' | 'archived'
  subscriber_count: string | number
  created_at: Date
}
const toPlan = (r: PlanRow): ApiPlan => ({
  id: r.id,
  productId: r.product_id,
  productName: r.product_name,
  name: r.name,
  amount: String(r.amount),
  interval: r.interval,
  trialDays: r.trial_days,
  escrowDays: r.escrow_days,
  status: r.status,
  subscriberCount: Number(r.subscriber_count),
  createdAt: iso(r.created_at) ?? '',
})

export async function listPlans(ctx: Ctx, orgId: string, page: Page): Promise<ApiPlan[]> {
  const rows = (await ctx.deps.db`
    SELECT pl.id, pl.product_id, pr.name AS product_name, pl.name, pl.amount::text AS amount, pl."interval",
           pl.trial_days, pl.escrow_days, pl.status, pl.created_at,
           (SELECT count(*) FROM subscriptions s WHERE s.org_id = pl.org_id AND s.plan_id = pl.id AND s.status <> 'canceled') AS subscriber_count
    FROM plans pl JOIN products pr ON pr.org_id = pl.org_id AND pr.id = pl.product_id
    WHERE pl.org_id = ${orgId}
    ORDER BY pl.created_at DESC LIMIT ${page.limit} OFFSET ${page.offset}`) as PlanRow[]
  return rows.map(toPlan)
}

export async function getPlan(ctx: Ctx, orgId: string, id: string): Promise<ApiPlan> {
  const rows = (await ctx.deps.db`
    SELECT pl.id, pl.product_id, pr.name AS product_name, pl.name, pl.amount::text AS amount, pl."interval",
           pl.trial_days, pl.escrow_days, pl.status, pl.created_at,
           (SELECT count(*) FROM subscriptions s WHERE s.org_id = pl.org_id AND s.plan_id = pl.id AND s.status <> 'canceled') AS subscriber_count
    FROM plans pl JOIN products pr ON pr.org_id = pl.org_id AND pr.id = pl.product_id
    WHERE pl.org_id = ${orgId} AND pl.id = ${id}`) as PlanRow[]
  if (!rows[0]) throw notFound('Plan')
  return toPlan(rows[0])
}

export async function createPlan(ctx: Ctx, orgId: string, actorId: string, input: z.infer<typeof planBody>): Promise<ApiPlan> {
  // Composite FK (org_id, product_id) also enforces this; the explicit check gives a clean 404.
  const products = await ctx.deps.db`SELECT id FROM products WHERE org_id = ${orgId} AND id = ${input.productId} AND status = 'active'`
  if (!products.length) throw notFound('Product')
  try {
    const id = await withTx(ctx.deps.db, async (tx) => {
      const rows = (await tx`
        INSERT INTO plans (org_id, product_id, name, amount, "interval", trial_days, escrow_days)
        VALUES (${orgId}, ${input.productId}, ${input.name}, ${input.amount.toString()}::bigint, ${input.interval}, ${input.trialDays}, ${input.escrowDays})
        RETURNING id`) as { id: string }[]
      await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'plan.created', resourceType: 'plan', resourceId: rows[0].id, metadata: { amount: input.amount, interval: input.interval } })
      return rows[0].id
    })
    return await getPlan(ctx, orgId, id)
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('This product already has a plan with that name', 'duplicate_name')
    throw err
  }
}

export async function updatePlan(ctx: Ctx, orgId: string, actorId: string, id: string, patch: z.infer<typeof planPatch>): Promise<ApiPlan> {
  assertSomeUpdate(patch)
  try {
    const n = await withTx(ctx.deps.db, async (tx) => {
      const rows = await tx`
        UPDATE plans SET name = COALESCE(${patch.name ?? null}::text, name),
                         amount = COALESCE(${patch.amount?.toString() ?? null}::bigint, amount),
                         trial_days = COALESCE(${patch.trialDays ?? null}::int, trial_days),
                         escrow_days = COALESCE(${patch.escrowDays ?? null}::int, escrow_days),
                         status = COALESCE(${patch.status ?? null}::text, status)
        WHERE org_id = ${orgId} AND id = ${id} RETURNING id`
      if (rows.length) await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'plan.updated', resourceType: 'plan', resourceId: id, metadata: { fields: Object.keys(patch) } })
      return rows.length
    })
    if (!n) throw notFound('Plan')
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('This product already has a plan with that name', 'duplicate_name')
    throw err
  }
  return getPlan(ctx, orgId, id)
}

export async function deletePlan(ctx: Ctx, orgId: string, actorId: string, id: string): Promise<void> {
  await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`DELETE FROM plans WHERE org_id = ${orgId} AND id = ${id} RETURNING id`
    if (!rows.length) throw notFound('Plan')
    await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'plan.deleted', resourceType: 'plan', resourceId: id })
  }).catch((err: unknown) => {
    if (pgCode(err) === PG.foreignKeyViolation) throw conflict('Archive this plan instead: subscriptions use it', 'in_use')
    throw err
  })
}
