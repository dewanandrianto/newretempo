import { z } from 'zod'
import type { ApiPayment } from '@shared/types'
import { PG, pgCode, withTx } from '../db/client'
import { conflict, notFound } from '../http/errors'
import type { Ctx } from '../http/types'
import { audit } from './audit'
import { iso, requestHash, sameRequestOrThrow, uuid, type Page } from './common'

/**
 * Payment RECORDS. In Phase 2 a payment can only be created as 'pending' (an intent to pay an
 * open invoice) and cancelled. 'processing' and 'succeeded', the transaction hash and the
 * confirmation time can only be written by verified chain-event processing; the database
 * enforces that (see migration 0007), so a request body can never claim a payment succeeded.
 */
export const paymentBody = z.object({ invoiceId: uuid })

interface Row {
  id: string
  invoice_id: string
  invoice_number: string
  customer_id: string
  customer_name: string
  amount: string
  status: ApiPayment['status']
  chain_id: string
  tx_hash: string | null
  created_at: Date
}
const toPayment = (r: Row): ApiPayment => ({
  id: r.id,
  invoiceId: r.invoice_id,
  invoiceNumber: r.invoice_number,
  customerId: r.customer_id,
  customerName: r.customer_name,
  amount: String(r.amount),
  status: r.status,
  chainId: Number(r.chain_id),
  txHash: r.tx_hash,
  createdAt: iso(r.created_at) ?? '',
})

export async function listPayments(ctx: Ctx, orgId: string, page: Page): Promise<ApiPayment[]> {
  const rows = (await ctx.deps.db`
    SELECT p.id, p.invoice_id, i.number AS invoice_number, p.customer_id, c.name AS customer_name,
           p.amount::text AS amount, p.status, p.chain_id::text AS chain_id, p.tx_hash, p.created_at
    FROM payments p
    JOIN invoices i ON i.org_id = p.org_id AND i.id = p.invoice_id
    JOIN customers c ON c.org_id = p.org_id AND c.id = p.customer_id
    WHERE p.org_id = ${orgId} ORDER BY p.created_at DESC LIMIT ${page.limit} OFFSET ${page.offset}`) as Row[]
  return rows.map(toPayment)
}

export async function getPayment(ctx: Ctx, orgId: string, id: string): Promise<ApiPayment> {
  const rows = (await ctx.deps.db`
    SELECT p.id, p.invoice_id, i.number AS invoice_number, p.customer_id, c.name AS customer_name,
           p.amount::text AS amount, p.status, p.chain_id::text AS chain_id, p.tx_hash, p.created_at
    FROM payments p
    JOIN invoices i ON i.org_id = p.org_id AND i.id = p.invoice_id
    JOIN customers c ON c.org_id = p.org_id AND c.id = p.customer_id
    WHERE p.org_id = ${orgId} AND p.id = ${id}`) as Row[]
  if (!rows[0]) throw notFound('Payment')
  return toPayment(rows[0])
}

async function findByKey(ctx: Ctx, orgId: string, key: string) {
  const rows = (await ctx.deps.db`SELECT id, request_hash FROM payments WHERE org_id = ${orgId} AND idempotency_key = ${key}`) as { id: string; request_hash: string }[]
  return rows[0] ?? null
}

export async function createPayment(
  ctx: Ctx,
  orgId: string,
  actorId: string,
  key: string,
  input: z.infer<typeof paymentBody>,
): Promise<{ payment: ApiPayment; replayed: boolean }> {
  const hash = requestHash({ invoiceId: input.invoiceId })
  const replay = async () => {
    const existing = await findByKey(ctx, orgId, key)
    if (!existing) return null
    sameRequestOrThrow(existing.request_hash, hash)
    return { payment: await getPayment(ctx, orgId, existing.id), replayed: true }
  }
  const prior = await replay()
  if (prior) return prior

  try {
    const id = await withTx(ctx.deps.db, async (tx) => {
      // Lock the invoice row so two concurrent requests serialize on it.
      const invoices = (await tx`
        SELECT customer_id, status, (total_amount - amount_paid)::text AS remaining
        FROM invoices WHERE org_id = ${orgId} AND id = ${input.invoiceId} FOR UPDATE`) as { customer_id: string; status: string; remaining: string }[]
      const invoice = invoices[0]
      if (!invoice) throw notFound('Invoice')
      if (invoice.status !== 'open') throw conflict('Only open invoices can receive a payment record', 'invoice_not_open')
      const rows = (await tx`
        INSERT INTO payments (org_id, invoice_id, customer_id, amount, chain_id, idempotency_key, request_hash)
        VALUES (${orgId}, ${input.invoiceId}, ${invoice.customer_id}, ${invoice.remaining}::bigint, ${ctx.deps.config.siwe.chainId}, ${key}, ${hash})
        RETURNING id`) as { id: string }[]
      await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'payment.created', resourceType: 'payment', resourceId: rows[0].id, metadata: { invoiceId: input.invoiceId, amount: invoice.remaining, status: 'pending' } })
      return rows[0].id
    })
    return { payment: await getPayment(ctx, orgId, id), replayed: false }
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) {
      const raced = await replay()
      if (raced) return raced
      throw conflict('This invoice already has a live payment record', 'payment_exists')
    }
    throw err
  }
}

export async function cancelPayment(ctx: Ctx, orgId: string, actorId: string, id: string): Promise<ApiPayment> {
  const n = await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`UPDATE payments SET status = 'canceled' WHERE org_id = ${orgId} AND id = ${id} AND status = 'pending' RETURNING id`
    if (rows.length) await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'payment.canceled', resourceType: 'payment', resourceId: id })
    return rows.length
  })
  if (!n) throw conflict('Only pending payments can be canceled', 'not_pending')
  return getPayment(ctx, orgId, id)
}
