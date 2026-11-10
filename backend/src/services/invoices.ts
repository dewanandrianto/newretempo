import { z } from 'zod'
import { MoneyError, sumBaseUnits, MAX_BASE_UNITS } from '@shared/money'
import type { ApiInvoice, ApiLineItem } from '@shared/types'
import { PG, pgCode, withTx, type Db } from '../db/client'
import { conflict, notFound, validationFailed } from '../http/errors'
import type { Ctx } from '../http/types'
import { audit } from './audit'
import { assertSomeUpdate, iso, isoDate, positiveBaseUnits, requestHash, sameRequestOrThrow, shortText, uuid, type Page } from './common'

const lineItem = z.object({
  description: shortText(200),
  quantity: z.number().int().min(1).max(10_000),
  unitAmount: positiveBaseUnits,
})
const lineItems = z.array(lineItem).min(1, 'Add at least one line item').max(50)

export const invoiceBody = z.object({
  customerId: uuid,
  subscriptionId: uuid.optional(),
  periodStart: isoDate.optional(),
  lineItems,
  dueAt: isoDate,
  memo: z.string().trim().max(1000).default(''),
})
export const invoicePatch = z.object({
  lineItems: lineItems.optional(),
  dueAt: isoDate.optional(),
  memo: z.string().trim().max(1000).optional(),
})

type Items = z.infer<typeof lineItems>

/** Exact integer total. Throws a validation error rather than overflowing BIGINT. */
export function totalOf(items: Items): bigint {
  try {
    return sumBaseUnits(items.map((i) => BigInt(i.quantity) * i.unitAmount))
  } catch (err) {
    if (err instanceof MoneyError) throw validationFailed({ lineItems: 'Invoice total is too large' })
    throw err
  }
}

const wireItems = (items: Items) => items.map((i) => ({ description: i.description, quantity: i.quantity, unitAmount: i.unitAmount.toString() }))

interface Row {
  id: string
  number: string
  customer_id: string
  customer_name: string
  customer_email: string
  subscription_id: string | null
  status: ApiInvoice['status']
  total_amount: string
  amount_paid: string
  line_items: ApiLineItem[] | string
  memo: string
  issued_at: Date | null
  due_at: Date
  created_at: Date
}
const toInvoice = (r: Row): ApiInvoice => ({
  id: r.id,
  number: r.number,
  customerId: r.customer_id,
  customerName: r.customer_name,
  customerEmail: r.customer_email,
  subscriptionId: r.subscription_id,
  status: r.status,
  total: String(r.total_amount),
  amountPaid: String(r.amount_paid),
  lineItems: typeof r.line_items === 'string' ? (JSON.parse(r.line_items) as ApiLineItem[]) : r.line_items,
  memo: r.memo,
  issuedAt: iso(r.issued_at),
  dueAt: iso(r.due_at) ?? '',
  createdAt: iso(r.created_at) ?? '',
})

export async function listInvoices(ctx: Ctx, orgId: string, page: Page): Promise<ApiInvoice[]> {
  const rows = (await ctx.deps.db`
    SELECT i.id, i.number, i.customer_id, c.name AS customer_name, c.email AS customer_email, i.subscription_id, i.status,
           i.total_amount::text AS total_amount, i.amount_paid::text AS amount_paid, i.line_items, i.memo,
           i.issued_at, i.due_at, i.created_at
    FROM invoices i JOIN customers c ON c.org_id = i.org_id AND c.id = i.customer_id
    WHERE i.org_id = ${orgId} ORDER BY i.created_at DESC LIMIT ${page.limit} OFFSET ${page.offset}`) as Row[]
  return rows.map(toInvoice)
}
export async function getInvoice(ctx: Ctx, orgId: string, id: string, db: Db = ctx.deps.db): Promise<ApiInvoice> {
  const rows = (await db`
    SELECT i.id, i.number, i.customer_id, c.name AS customer_name, c.email AS customer_email, i.subscription_id, i.status,
           i.total_amount::text AS total_amount, i.amount_paid::text AS amount_paid, i.line_items, i.memo,
           i.issued_at, i.due_at, i.created_at
    FROM invoices i JOIN customers c ON c.org_id = i.org_id AND c.id = i.customer_id
    WHERE i.org_id = ${orgId} AND i.id = ${id}`) as Row[]
  if (!rows[0]) throw notFound('Invoice')
  return toInvoice(rows[0])
}

async function findByKey(ctx: Ctx, orgId: string, key: string): Promise<{ id: string; request_hash: string } | null> {
  const rows = (await ctx.deps.db`SELECT id, request_hash FROM invoices WHERE org_id = ${orgId} AND idempotency_key = ${key}`) as { id: string; request_hash: string }[]
  return rows[0] ?? null
}

export async function createInvoice(
  ctx: Ctx,
  orgId: string,
  actorId: string,
  key: string,
  input: z.infer<typeof invoiceBody>,
): Promise<{ invoice: ApiInvoice; replayed: boolean }> {
  if (input.subscriptionId && !input.periodStart) {
    throw validationFailed({ periodStart: 'Billing period start is required for subscription invoices' })
  }
  const hash = requestHash({ ...input, lineItems: wireItems(input.lineItems), dueAt: input.dueAt.toISOString(), periodStart: input.periodStart?.toISOString() })

  const replay = async () => {
    const existing = await findByKey(ctx, orgId, key)
    if (!existing) return null
    sameRequestOrThrow(existing.request_hash, hash)
    return { invoice: await getInvoice(ctx, orgId, existing.id), replayed: true }
  }
  const prior = await replay()
  if (prior) return prior

  const total = totalOf(input.lineItems)
  if (total <= 0n || total > MAX_BASE_UNITS) throw validationFailed({ lineItems: 'Invoice total must be greater than zero' })

  try {
    const id = await withTx(ctx.deps.db, async (tx) => {
      const customers = await tx`SELECT id FROM customers WHERE org_id = ${orgId} AND id = ${input.customerId} AND status = 'active'`
      if (!customers.length) throw notFound('Customer')
      if (input.subscriptionId) {
        const subs = await tx`SELECT id FROM subscriptions WHERE org_id = ${orgId} AND id = ${input.subscriptionId} AND customer_id = ${input.customerId}`
        if (!subs.length) throw notFound('Subscription')
      }
      // Gapless per-organization numbering; rolls back together with the insert.
      const counter = (await tx`UPDATE organizations SET invoice_counter = invoice_counter + 1 WHERE id = ${orgId} RETURNING invoice_counter::text AS n`) as { n: string }[]
      const number = `INV-${new Date().getUTCFullYear()}-${counter[0].n.padStart(6, '0')}`
      const rows = (await tx`
        INSERT INTO invoices (org_id, customer_id, subscription_id, number, total_amount, line_items, memo, period_start, due_at, idempotency_key, request_hash)
        VALUES (${orgId}, ${input.customerId}, ${input.subscriptionId ?? null}, ${number}, ${total.toString()}::bigint,
                (${JSON.stringify(wireItems(input.lineItems))}::text)::jsonb, ${input.memo}, ${input.periodStart?.toISOString() ?? null}::timestamptz,
                ${input.dueAt.toISOString()}::timestamptz, ${key}, ${hash})
        RETURNING id`) as { id: string }[]
      await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'invoice.created', resourceType: 'invoice', resourceId: rows[0].id, metadata: { number, total } })
      return rows[0].id
    })
    return { invoice: await getInvoice(ctx, orgId, id), replayed: false }
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) {
      const raced = await replay() // concurrent retry with the same key
      if (raced) return raced
      throw conflict('An invoice already exists for this subscription period', 'duplicate_invoice')
    }
    throw err
  }
}

export async function updateInvoice(ctx: Ctx, orgId: string, actorId: string, id: string, patch: z.infer<typeof invoicePatch>): Promise<ApiInvoice> {
  assertSomeUpdate(patch)
  const total = patch.lineItems ? totalOf(patch.lineItems) : null
  const n = await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`
      UPDATE invoices SET
        line_items = COALESCE((${patch.lineItems ? JSON.stringify(wireItems(patch.lineItems)) : null}::text)::jsonb, line_items),
        total_amount = COALESCE(${total?.toString() ?? null}::bigint, total_amount),
        due_at = COALESCE(${patch.dueAt?.toISOString() ?? null}::timestamptz, due_at),
        memo = COALESCE(${patch.memo ?? null}::text, memo)
      WHERE org_id = ${orgId} AND id = ${id} AND status = 'draft' RETURNING id`
    if (rows.length) await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'invoice.updated', resourceType: 'invoice', resourceId: id, metadata: { fields: Object.keys(patch) } })
    return rows.length
  })
  if (!n) throw conflict('Only draft invoices can be edited', 'not_draft')
  return getInvoice(ctx, orgId, id)
}

export async function finalizeInvoice(ctx: Ctx, orgId: string, actorId: string, id: string): Promise<ApiInvoice> {
  const n = await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`UPDATE invoices SET status = 'open', issued_at = now() WHERE org_id = ${orgId} AND id = ${id} AND status = 'draft' RETURNING id`
    if (rows.length) await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'invoice.finalized', resourceType: 'invoice', resourceId: id })
    return rows.length
  })
  if (!n) throw conflict('Only draft invoices can be finalized', 'not_draft')
  return getInvoice(ctx, orgId, id)
}

export async function voidInvoice(ctx: Ctx, orgId: string, actorId: string, id: string): Promise<ApiInvoice> {
  const n = await withTx(ctx.deps.db, async (tx) => {
    const live = await tx`SELECT id FROM payments WHERE org_id = ${orgId} AND invoice_id = ${id} AND status IN ('pending', 'processing', 'succeeded')`
    if (live.length) throw conflict('Cancel or resolve the payment on this invoice first', 'has_live_payment')
    const rows = await tx`UPDATE invoices SET status = 'void' WHERE org_id = ${orgId} AND id = ${id} AND status IN ('draft', 'open') RETURNING id`
    if (rows.length) await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'invoice.voided', resourceType: 'invoice', resourceId: id })
    return rows.length
  })
  if (!n) throw conflict('Only draft or open invoices can be voided', 'not_voidable')
  return getInvoice(ctx, orgId, id)
}

export async function deleteInvoice(ctx: Ctx, orgId: string, actorId: string, id: string): Promise<void> {
  await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`DELETE FROM invoices WHERE org_id = ${orgId} AND id = ${id} AND status = 'draft' RETURNING id`
    if (!rows.length) throw conflict('Only draft invoices can be deleted. Void it instead.', 'not_draft')
    await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'invoice.deleted', resourceType: 'invoice', resourceId: id })
  })
}
