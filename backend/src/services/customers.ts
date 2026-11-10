import { z } from 'zod'
import type { ApiCustomer } from '@shared/types'
import { PG, pgCode, withTx } from '../db/client'
import { conflict, notFound } from '../http/errors'
import type { Ctx } from '../http/types'
import { audit } from './audit'
import { assertSomeUpdate, iso, shortText, type Page } from './common'

const email = z.string().trim().toLowerCase().max(254).pipe(z.email())

export const customerBody = z.object({
  name: shortText(120),
  email,
  company: z.string().trim().max(120).default(''),
})
export const customerPatch = z.object({
  name: shortText(120).optional(),
  email: email.optional(),
  company: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'archived']).optional(),
})

interface Row {
  id: string
  name: string
  email: string
  company: string
  status: 'active' | 'archived'
  created_at: Date
}
const toCustomer = (r: Row): ApiCustomer => ({
  id: r.id,
  name: r.name,
  email: r.email,
  company: r.company,
  status: r.status,
  createdAt: iso(r.created_at) ?? '',
})

export async function listCustomers(ctx: Ctx, orgId: string, page: Page): Promise<ApiCustomer[]> {
  const rows = (await ctx.deps.db`
    SELECT id, name, email, company, status, created_at FROM customers
    WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT ${page.limit} OFFSET ${page.offset}`) as Row[]
  return rows.map(toCustomer)
}

export async function getCustomer(ctx: Ctx, orgId: string, id: string): Promise<ApiCustomer> {
  const rows = (await ctx.deps.db`
    SELECT id, name, email, company, status, created_at FROM customers WHERE org_id = ${orgId} AND id = ${id}`) as Row[]
  if (!rows[0]) throw notFound('Customer')
  return toCustomer(rows[0])
}

export async function createCustomer(ctx: Ctx, orgId: string, actorId: string, input: z.infer<typeof customerBody>): Promise<ApiCustomer> {
  try {
    const id = await withTx(ctx.deps.db, async (tx) => {
      const rows = (await tx`
        INSERT INTO customers (org_id, name, email, company) VALUES (${orgId}, ${input.name}, ${input.email}, ${input.company})
        RETURNING id`) as { id: string }[]
      await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'customer.created', resourceType: 'customer', resourceId: rows[0].id })
      return rows[0].id
    })
    return await getCustomer(ctx, orgId, id)
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('A customer with this email already exists', 'duplicate_email')
    throw err
  }
}

export async function updateCustomer(ctx: Ctx, orgId: string, actorId: string, id: string, patch: z.infer<typeof customerPatch>): Promise<ApiCustomer> {
  assertSomeUpdate(patch)
  try {
    const n = await withTx(ctx.deps.db, async (tx) => {
      const rows = await tx`
        UPDATE customers SET name = COALESCE(${patch.name ?? null}::text, name),
                             email = COALESCE(${patch.email ?? null}::text, email),
                             company = COALESCE(${patch.company ?? null}::text, company),
                             status = COALESCE(${patch.status ?? null}::text, status)
        WHERE org_id = ${orgId} AND id = ${id} RETURNING id`
      if (rows.length) await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'customer.updated', resourceType: 'customer', resourceId: id, metadata: { fields: Object.keys(patch) } })
      return rows.length
    })
    if (!n) throw notFound('Customer')
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('A customer with this email already exists', 'duplicate_email')
    throw err
  }
  return getCustomer(ctx, orgId, id)
}

export async function deleteCustomer(ctx: Ctx, orgId: string, actorId: string, id: string): Promise<void> {
  await withTx(ctx.deps.db, async (tx) => {
    const rows = await tx`DELETE FROM customers WHERE org_id = ${orgId} AND id = ${id} RETURNING id`
    if (!rows.length) throw notFound('Customer')
    await audit(tx, ctx, { orgId, actorUserId: actorId, action: 'customer.deleted', resourceType: 'customer', resourceId: id })
  }).catch((err: unknown) => {
    if (pgCode(err) === PG.foreignKeyViolation) throw conflict('Archive this customer instead: they have subscriptions or invoices', 'in_use')
    throw err
  })
}
