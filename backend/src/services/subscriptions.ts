import { z } from 'zod'
import type { ApiSubscription } from '@shared/types'
import { PG, pgCode, withTx } from '../db/client'
import { conflict, notFound } from '../http/errors'
import type { Ctx } from '../http/types'
import { audit } from './audit'
import { assertSomeUpdate, iso, uuid, type Page } from './common'

/**
 * Phase 2 creates subscriptions as 'incomplete': there is no payment authorization (mandate)
 * and no contract yet, so a merchant can neither activate one nor mark it paid.
 * Merchants may cancel; every other status transition belongs to verified chain events later.
 */
export const subscriptionBody = z.object({ customerId: uuid, planId: uuid })
export const subscriptionPatch = z.object({
  status: z.literal('canceled').optional(),
  cancelAtPeriodEnd: z.boolean().optional(),
})

interface Row {
  id: string
  customer_id: string
  customer_name: string
  plan_id: string
  plan_name: string
  status: ApiSubscription['status']
  amount: string
  interval: ApiSubscription['interval']
  current_period_start: Date | null
  current_period_end: Date | null
  cancel_at_period_end: boolean
  created_at: Date
}
const toSub = (r: Row): ApiSubscription => ({
  id: r.id,
  customerId: r.customer_id,
  customerName: r.customer_name,
  planId: r.plan_id,
  planName: r.plan_name,
  status: r.status,
  amount: String(r.amount),
  interval: r.interval,
  currentPeriodStart: iso(r.current_period_start),
  currentPeriodEnd: iso(r.current_period_end),
  cancelAtPeriodEnd: r.cancel_at_period_end,
  createdAt: iso(r.created_at) ?? '',
})

export async function listSubscriptions(ctx: Ctx, orgId: string, page: Page): Promise<ApiSubscription[]> {
  const rows = (await ctx.deps.db`
    SELECT s.id, s.customer_id, c.name AS customer_name, s.plan_id, p.name AS plan_name, s.status,
           s.amount::text AS amount, s."interval", s.current_period_start, s.current_period_end,
           s.cancel_at_period_end, s.created_at
    FROM subscriptions s
    JOIN customers c ON c.org_id = s.org_id AND c.id = s.customer_id
    JOIN plans p ON p.org_id = s.org_id AND p.id = s.plan_id
    WHERE s.org_id = ${orgId} ORDER BY s.created_at DESC LIMIT ${page.limit} OFFSET ${page.offset}`) as Row[]
  return rows.map(toSub)
}

export async function getSubscription(ctx: Ctx, orgId: string, id: string): Promise<ApiSubscription> {
  const rows = (await ctx.deps.db`
    SELECT s.id, s.customer_id, c.name AS customer_name, s.plan_id, p.name AS plan_name, s.status,
           s.amount::text AS amount, s."interval", s.current_period_start, s.current_period_end,
           s.cancel_at_period_end, s.created_at
    FROM subscriptions s
    JOIN customers c ON c.org_id = s.org_id AND c.id = s.customer_id
    JOIN plans p ON p.org_id = s.org_id AND p.id = s.plan_id
    WHERE s.org_id = ${orgId} AND s.id = ${id}`) as Row[]
  if (!rows[0]) throw notFound('Subscription')
  return toSub(rows[0])
}

export async function createSubscription(ctx: Ctx, orgId: string, actorId: string, input: z.infer<typeof subscriptionBody>): Promise<ApiSubscription> {
  const id = await withTx(ctx.deps.db, async (tx) => {
    const plans = (await tx`
      SELECT amount::text AS amount, "interval" FROM plans WHERE org_id = ${orgId} AND id = ${input.planId} AND status = 'active'`) as {
      amount: string
      interval: string
    }[]
    if (!plans[0]) throw notFound('Plan')
    const customers = await tx`SELECT id FROM customers WHERE org_id = ${orgId} AND id = ${input.customerId} AND status = 'active'`
    if (!customers.length) throw notFound('Customer')
    const live = await tx`
      SELECT id FROM subscriptions WHERE org_id = ${orgId} AND customer_id = ${input.customerId} AND plan_id = ${input.planId} AND status <> 'canceled'`
    if (live.length) throw conflict('This customer already has an open subscription to this plan', 'duplicate_subscription')
    const rows = (await tx`
      INSERT INTO subscriptions (org_id, customer_id, plan_id, status, amount, "interval")
      VALUES (${orgId}, ${input.customerId}, ${input.planId}, 'incomplete', ${plans[0].amount}::bigint, ${plans[0].interval})
      RETURNING id`) as { id: string }[]
    await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'subscription.created', resourceType: 'subscription', resourceId: rows[0].id, metadata: { planId: input.planId, customerId: input.customerId } })
    return rows[0].id
  })
  return getSubscription(ctx, orgId, id)
}

export async function updateSubscription(ctx: Ctx, orgId: string, actorId: string, id: string, patch: z.infer<typeof subscriptionPatch>): Promise<ApiSubscription> {
  assertSomeUpdate(patch)
  const n = await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`
      UPDATE subscriptions SET
        status = COALESCE(${patch.status ?? null}::text, status),
        canceled_at = CASE WHEN ${patch.status === 'canceled'}::bool THEN now() ELSE canceled_at END,
        cancel_at_period_end = COALESCE(${patch.cancelAtPeriodEnd ?? null}::bool, cancel_at_period_end)
      WHERE org_id = ${orgId} AND id = ${id} AND status <> 'canceled' RETURNING id`
    if (rows.length) await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'subscription.updated', resourceType: 'subscription', resourceId: id, metadata: { fields: Object.keys(patch) } })
    return rows.length
  })
  if (!n) throw notFound('Open subscription')
  return getSubscription(ctx, orgId, id)
}

export async function deleteSubscription(ctx: Ctx, orgId: string, actorId: string, id: string): Promise<void> {
  await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`DELETE FROM subscriptions WHERE org_id = ${orgId} AND id = ${id} AND status IN ('incomplete', 'canceled') RETURNING id`
    if (!rows.length) throw notFound('Deletable subscription')
    await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'subscription.deleted', resourceType: 'subscription', resourceId: id })
  }).catch((err: unknown) => {
    if (pgCode(err) === PG.foreignKeyViolation) throw conflict('Cancel this subscription instead: invoices reference it', 'in_use')
    throw err
  })
}
