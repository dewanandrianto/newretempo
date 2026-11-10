import { z } from 'zod'
import type { ApiAuditLog, ApiEscrow } from '@shared/types'
import { PG, pgCode, withTx } from '../db/client'
import { conflict, notFound } from '../http/errors'
import type { Ctx } from '../http/types'
import { audit } from './audit'
import { iso, requestHash, sameRequestOrThrow, uuid, type Page } from './common'

/**
 * Escrow RECORDS only. A record is created as 'pending_funding' and nothing in the HTTP API can
 * move it to funded / released / refunded / settled / disputed, or attach chain references.
 * Those transitions are reserved for verified blockchain events (Phase 3) and are enforced by
 * a database trigger, not just by this module. Every create / update / delete is audited.
 */
export const escrowBody = z.object({
  invoiceId: uuid,
  releaseAfterDays: z.number().int().min(0).max(90).default(0),
})
export const escrowPatch = z.object({ releaseAfterDays: z.number().int().min(0).max(90) })

interface Row {
  id: string
  invoice_id: string
  invoice_number: string
  customer_id: string
  customer_name: string
  amount: string
  status: ApiEscrow['status']
  release_after_days: number
  release_at: Date | null
  contract_address: string | null
  created_at: Date
}
const toEscrow = (r: Row): ApiEscrow => ({
  id: r.id,
  invoiceId: r.invoice_id,
  invoiceNumber: r.invoice_number,
  customerId: r.customer_id,
  customerName: r.customer_name,
  amount: String(r.amount),
  status: r.status,
  releaseAfterDays: r.release_after_days,
  releaseAt: iso(r.release_at),
  contractAddress: r.contract_address,
  createdAt: iso(r.created_at) ?? '',
})

export async function listEscrows(ctx: Ctx, orgId: string, page: Page): Promise<ApiEscrow[]> {
  const rows = (await ctx.deps.db`
    SELECT e.id, e.invoice_id, i.number AS invoice_number, e.customer_id, c.name AS customer_name, e.amount::text AS amount,
           e.status, e.release_after_days, e.release_at, e.contract_address, e.created_at
    FROM escrows e
    JOIN invoices i ON i.org_id = e.org_id AND i.id = e.invoice_id
    JOIN customers c ON c.org_id = e.org_id AND c.id = e.customer_id
    WHERE e.org_id = ${orgId} ORDER BY e.created_at DESC LIMIT ${page.limit} OFFSET ${page.offset}`) as Row[]
  return rows.map(toEscrow)
}

export async function getEscrow(ctx: Ctx, orgId: string, id: string): Promise<ApiEscrow> {
  const rows = (await ctx.deps.db`
    SELECT e.id, e.invoice_id, i.number AS invoice_number, e.customer_id, c.name AS customer_name, e.amount::text AS amount,
           e.status, e.release_after_days, e.release_at, e.contract_address, e.created_at
    FROM escrows e
    JOIN invoices i ON i.org_id = e.org_id AND i.id = e.invoice_id
    JOIN customers c ON c.org_id = e.org_id AND c.id = e.customer_id
    WHERE e.org_id = ${orgId} AND e.id = ${id}`) as Row[]
  if (!rows[0]) throw notFound('Escrow')
  return toEscrow(rows[0])
}

async function findByKey(ctx: Ctx, orgId: string, key: string) {
  const rows = (await ctx.deps.db`SELECT id, request_hash FROM escrows WHERE org_id = ${orgId} AND idempotency_key = ${key}`) as { id: string; request_hash: string }[]
  return rows[0] ?? null
}

export async function createEscrow(
  ctx: Ctx,
  orgId: string,
  actorId: string,
  key: string,
  input: z.infer<typeof escrowBody>,
): Promise<{ escrow: ApiEscrow; replayed: boolean }> {
  const hash = requestHash(input)
  const replay = async () => {
    const existing = await findByKey(ctx, orgId, key)
    if (!existing) return null
    sameRequestOrThrow(existing.request_hash, hash)
    return { escrow: await getEscrow(ctx, orgId, existing.id), replayed: true }
  }
  const prior = await replay()
  if (prior) return prior

  try {
    const id = await withTx(ctx.deps.db, async (tx) => {
      const invoices = (await tx`
        SELECT customer_id, status, total_amount::text AS total FROM invoices
        WHERE org_id = ${orgId} AND id = ${input.invoiceId} FOR UPDATE`) as { customer_id: string; status: string; total: string }[]
      const invoice = invoices[0]
      if (!invoice) throw notFound('Invoice')
      if (invoice.status !== 'open') throw conflict('Escrow records can only be created for open invoices', 'invoice_not_open')
      const rows = (await tx`
        INSERT INTO escrows (org_id, invoice_id, customer_id, amount, release_after_days, chain_id, idempotency_key, request_hash)
        VALUES (${orgId}, ${input.invoiceId}, ${invoice.customer_id}, ${invoice.total}::bigint, ${input.releaseAfterDays},
                ${ctx.deps.config.siwe.chainId}, ${key}, ${hash})
        RETURNING id`) as { id: string }[]
      await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'escrow.created', resourceType: 'escrow', resourceId: rows[0].id, metadata: { invoiceId: input.invoiceId, amount: invoice.total, status: 'pending_funding' } })
      return rows[0].id
    })
    return { escrow: await getEscrow(ctx, orgId, id), replayed: false }
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) {
      const raced = await replay()
      if (raced) return raced
      throw conflict('This invoice already has a live escrow record', 'escrow_exists')
    }
    throw err
  }
}

export async function updateEscrow(ctx: Ctx, orgId: string, actorId: string, id: string, patch: z.infer<typeof escrowPatch>): Promise<ApiEscrow> {
  const n = await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`
      UPDATE escrows SET release_after_days = ${patch.releaseAfterDays}
      WHERE org_id = ${orgId} AND id = ${id} AND status = 'pending_funding' RETURNING id`
    if (rows.length) await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'escrow.terms_updated', resourceType: 'escrow', resourceId: id, metadata: { releaseAfterDays: patch.releaseAfterDays } })
    return rows.length
  })
  if (!n) throw conflict('Terms can only change while the escrow is pending funding', 'not_pending_funding')
  return getEscrow(ctx, orgId, id)
}

export async function deleteEscrow(ctx: Ctx, orgId: string, actorId: string, id: string): Promise<void> {
  await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`DELETE FROM escrows WHERE org_id = ${orgId} AND id = ${id} AND status = 'pending_funding' RETURNING id`
    if (!rows.length) throw conflict('Only unfunded escrow records can be discarded', 'not_pending_funding')
    await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'escrow.discarded', resourceType: 'escrow', resourceId: id })
  })
}

/** Full audit trail for one escrow record, oldest first. */
export async function escrowHistory(ctx: Ctx, orgId: string, id: string): Promise<ApiAuditLog[]> {
  await getEscrow(ctx, orgId, id)
  const rows = (await ctx.deps.db`
    SELECT id, action, resource_type, resource_id, actor_user_id, actor_type, metadata, created_at
    FROM audit_logs WHERE org_id = ${orgId} AND resource_type = 'escrow' AND resource_id = ${id}
    ORDER BY created_at, id`) as {
    id: string
    action: string
    resource_type: string
    resource_id: string | null
    actor_user_id: string | null
    actor_type: ApiAuditLog['actorType']
    metadata: Record<string, unknown>
    created_at: Date
  }[]
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    actorUserId: r.actor_user_id,
    actorType: r.actor_type,
    metadata: r.metadata,
    createdAt: iso(r.created_at) ?? '',
  }))
}
