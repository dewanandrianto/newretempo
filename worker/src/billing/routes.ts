import { requireUnboundSubscription } from '../chain/lifecycle'
import { overlayBilling } from '../chain/projections'
import type { Context } from 'hono'
import { z } from 'zod'
import type { WorkerApp, WorkerContext } from '../types'
import { requireWorkerOrg, resourceId } from '../auth/guards'
import { auditStatement } from '../audit'
import { newId, nowIso, parsePage, stableHash, idempotencyKey as key, assertSomeUpdate as someUpdate, uuid, isoDate as date } from '../common'
import { conflict, notFound, validationFailed } from '../errors'
import { readBody } from '../http'
import { invoiceTotal, positiveAmount } from './money'

type C = Context<WorkerContext>
type Collection = 'subscriptions' | 'invoices' | 'payments' | 'escrows'
type Row = Record<string, string | number | null>
const items = z.array(z.object({ description: z.string().trim().min(1).max(200), quantity: z.number().int().min(1).max(10000), unitAmount: positiveAmount })).min(1).max(50)
const invoiceBody = z.object({ customerId: uuid, subscriptionId: uuid.optional(), periodStart: date.optional(), lineItems: items, dueAt: date, memo: z.string().trim().max(1000).default('') })
const invoicePatch = z.object({ lineItems: items.optional(), dueAt: date.optional(), memo: z.string().trim().max(1000).optional() })
const subscriptionBody = z.object({ customerId: uuid, planId: uuid })
const subscriptionPatch = z.object({ status: z.literal('canceled').optional(), cancelAtPeriodEnd: z.boolean().optional() })
const paymentBody = z.object({ invoiceId: uuid })
const escrowBody = z.object({ invoiceId: uuid, releaseAfterDays: z.number().int().min(0).max(90).default(0) })
const escrowPatch = z.object({ releaseAfterDays: z.number().int().min(0).max(90) })
const singular = { subscriptions: 'subscription', invoices: 'invoice', payments: 'payment', escrows: 'escrow' } as const

const select = {
  subscriptions: 'SELECT r.*,c.name AS customer_name,p.name AS plan_name FROM subscriptions r JOIN customers c ON c.org_id=r.org_id AND c.id=r.customer_id JOIN plans p ON p.org_id=r.org_id AND p.id=r.plan_id',
  invoices: 'SELECT r.*,c.name AS customer_name,c.email AS customer_email FROM invoices r JOIN customers c ON c.org_id=r.org_id AND c.id=r.customer_id',
  payments: 'SELECT r.*,c.name AS customer_name,i.number AS invoice_number FROM payments r JOIN customers c ON c.org_id=r.org_id AND c.id=r.customer_id JOIN invoices i ON i.org_id=r.org_id AND i.id=r.invoice_id',
  escrows: 'SELECT r.*,c.name AS customer_name,i.number AS invoice_number FROM escrows r JOIN customers c ON c.org_id=r.org_id AND c.id=r.customer_id JOIN invoices i ON i.org_id=r.org_id AND i.id=r.invoice_id',
}
function wire(collection: Collection, r: Row) {
  const base = { id: r.id, customerId: r.customer_id, customerName: r.customer_name, status: r.status, createdAt: r.created_at }
  if (collection === 'subscriptions') return { ...base, planId: r.plan_id, planName: r.plan_name, amount: String(r.amount), interval: r.interval, currentPeriodStart: r.current_period_start, currentPeriodEnd: r.current_period_end, cancelAtPeriodEnd: Boolean(r.cancel_at_period_end) }
  if (collection === 'invoices') return { ...base, number: r.number, customerEmail: r.customer_email, subscriptionId: r.subscription_id, total: String(r.total_amount), amountPaid: String(r.amount_paid), lineItems: JSON.parse(String(r.line_items)) as unknown, memo: r.memo, issuedAt: r.issued_at, dueAt: r.due_at }
  const record = { ...base, invoiceId: r.invoice_id, invoiceNumber: r.invoice_number, amount: String(r.amount) }
  return collection === 'payments' ? { ...record, chainId: Number(r.chain_id), txHash: r.tx_hash } : { ...record, releaseAfterDays: r.release_after_days, releaseAt: r.release_at, contractAddress: r.contract_address }
}
async function row(c: C, collection: Collection, orgId: string, id: string): Promise<Row> {
  const r = await c.env.DB.prepare(`${select[collection]} WHERE r.org_id=? AND r.id=?`).bind(orgId, id).first<Row>()
  if (!r) throw notFound(singular[collection])
  return r
}
async function get(c: C, collection: Collection, orgId: string, id: string) { return wire(collection, await row(c, collection, orgId, id)) }
function unique(error: unknown) { return String(error).includes('UNIQUE constraint failed') || String(error).includes('financial records cannot be replaced') }
function conditionalFailure(error: unknown) { return String(error).includes('malformed JSON') }
/** A failed conditional write aborts the whole batch, including counters and audit.
 * SQLite changes() excludes AFTER-trigger writes and is scoped to this batch's connection.
 * json() deliberately rejects a non-JSON literal only on the failed branch.
 */
function assertChanged(c: C) { return c.env.DB.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('billing_write_condition_failed') END") }
async function mutate(c: C, orgId: string, actorUserId: string, collection: Collection, id: string, action: string, statement: D1PreparedStatement, metadata: Record<string, unknown> = {}, before: D1PreparedStatement[] = []) {
  await c.env.DB.batch([...before, statement, assertChanged(c), auditStatement(c, { orgId, actorUserId, action, resourceType: singular[collection], resourceId: id, metadata })])
}
async function replay(c: C, collection: 'invoices' | 'payments' | 'escrows', orgId: string, idempotencyKey: string, hash: string) {
  const prior = await c.env.DB.prepare(`SELECT id,request_hash FROM ${collection} WHERE org_id=? AND idempotency_key=?`).bind(orgId, idempotencyKey).first<{ id: string; request_hash: string }>()
  if (!prior) return null
  if (prior.request_hash !== hash) throw conflict('This Idempotency-Key was already used with a different request', 'idempotency_key_reused')
  return c.json(await get(c, collection, orgId, prior.id), 200)
}
async function activeCustomer(c: C, orgId: string, id: string) {
  if (!await c.env.DB.prepare("SELECT id FROM customers WHERE org_id=? AND id=? AND status='active'").bind(orgId, id).first()) throw notFound('Customer')
}

export function registerBillingRoutes(app: WorkerApp): void {
  for (const collection of ['subscriptions', 'invoices', 'payments', 'escrows'] as const) {
    app.get(`/api/orgs/:orgId/${collection}`, async c => {
      const { orgId } = await requireWorkerOrg(c, 'org:read')
      const page = parsePage(c)
      const result = await c.env.DB.prepare(`${select[collection]} WHERE r.org_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?`).bind(orgId, page.limit, page.offset).all<Row>()
      return c.json(await overlayBilling(c.env, orgId, collection, result.results.map(r => wire(collection, r))))
    })
    app.get(`/api/orgs/:orgId/${collection}/:id`, async c => {
      const { orgId } = await requireWorkerOrg(c, 'org:read')
      const record = await get(c, collection, orgId, resourceId(c))
      return c.json((await overlayBilling(c.env, orgId, collection, [record]))[0])
    })
  }
  app.post('/api/orgs/:orgId/subscriptions', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'subscriptions:write')
    const input = await readBody(c, subscriptionBody)
    await activeCustomer(c, orgId, input.customerId)
    if (!await c.env.DB.prepare("SELECT id FROM plans WHERE org_id=? AND id=? AND status='active'").bind(orgId, input.planId).first()) throw notFound('Plan')
    const id = newId()
    try {
      await mutate(c, orgId, auth.userId, 'subscriptions', id, 'subscription.created', c.env.DB.prepare(`INSERT INTO subscriptions (id,org_id,customer_id,plan_id,status,amount,"interval") SELECT ?,p.org_id,c.id,p.id,'incomplete',p.amount,p."interval" FROM plans p JOIN customers c ON c.org_id=p.org_id WHERE p.org_id=? AND p.id=? AND p.status='active' AND c.id=? AND c.status='active' AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.org_id=p.org_id AND s.customer_id=c.id AND s.plan_id=p.id AND s.status<>'canceled')`).bind(id, orgId, input.planId, input.customerId), input)
    } catch (e) {
      if (unique(e)) throw conflict('This customer already has an open subscription to this plan', 'duplicate_subscription')
      if (conditionalFailure(e)) {
        if (await c.env.DB.prepare("SELECT id FROM subscriptions WHERE org_id=? AND customer_id=? AND plan_id=? AND status<>'canceled'").bind(orgId, input.customerId, input.planId).first()) throw conflict('This customer already has an open subscription to this plan', 'duplicate_subscription')
        throw conflict('The plan or customer is no longer active', 'resource_changed')
      }
      throw e
    }
    return c.json(await get(c, 'subscriptions', orgId, id), 201)
  })
  app.patch('/api/orgs/:orgId/subscriptions/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'subscriptions:write')
    const id = resourceId(c), input = await readBody(c, subscriptionPatch)
    someUpdate(input)
    await row(c, 'subscriptions', orgId, id)
    await requireUnboundSubscription(c.env, orgId, id)
    try {
      await mutate(c, orgId, auth.userId, 'subscriptions', id, 'subscription.updated', c.env.DB.prepare("UPDATE subscriptions SET status=COALESCE(?,status),canceled_at=CASE WHEN ?='canceled' THEN ? ELSE canceled_at END,cancel_at_period_end=COALESCE(?,cancel_at_period_end) WHERE org_id=? AND id=? AND status<>'canceled'").bind(input.status ?? null, input.status ?? null, nowIso(), input.cancelAtPeriodEnd === undefined ? null : Number(input.cancelAtPeriodEnd), orgId, id), { fields: Object.keys(input) })
    } catch (e) { if (conditionalFailure(e)) throw notFound('Open subscription'); throw e }
    return c.json(await get(c, 'subscriptions', orgId, id))
  })
  app.delete('/api/orgs/:orgId/subscriptions/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'subscriptions:write')
    const id = resourceId(c)
    await row(c, 'subscriptions', orgId, id)
    await requireUnboundSubscription(c.env, orgId, id)
    try {
      await mutate(c, orgId, auth.userId, 'subscriptions', id, 'subscription.deleted', c.env.DB.prepare("DELETE FROM subscriptions WHERE org_id=? AND id=? AND status IN ('incomplete','canceled')").bind(orgId, id))
    } catch (e) {
      if (String(e).includes('FOREIGN KEY')) throw conflict('Cancel this subscription instead: invoices reference it', 'in_use')
      if (conditionalFailure(e)) throw notFound('Deletable subscription')
      throw e
    }
    return c.body(null, 204)
  })
  app.post('/api/orgs/:orgId/invoices', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'invoices:write')
    const idempotencyKey = key(c), input = await readBody(c, invoiceBody)
    if (input.subscriptionId && !input.periodStart) throw validationFailed({ periodStart: 'Billing period start is required for subscription invoices' })
    const hash = await stableHash(input)
    const prior = await replay(c, 'invoices', orgId, idempotencyKey, hash)
    if (prior) return prior
    const total = invoiceTotal(input.lineItems)
    await activeCustomer(c, orgId, input.customerId)
    if (input.subscriptionId && !await c.env.DB.prepare('SELECT id FROM subscriptions WHERE org_id=? AND id=? AND customer_id=?').bind(orgId, input.subscriptionId, input.customerId).first()) throw notFound('Subscription')
    const id = newId(), year = nowIso().slice(0, 4)
    try {
      await mutate(c, orgId, auth.userId, 'invoices', id, 'invoice.created', c.env.DB.prepare(`INSERT INTO invoices (id,org_id,customer_id,subscription_id,number,total_amount,line_items,memo,period_start,due_at,idempotency_key,request_hash) SELECT ?,o.id,c.id,?,printf('INV-${year}-%06d',o.invoice_counter),?,?,?,?,?,?,? FROM organizations o JOIN customers c ON c.org_id=o.id WHERE o.id=? AND c.id=? AND c.status='active' AND (? IS NULL OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.org_id=o.id AND s.id=? AND s.customer_id=c.id))`).bind(id, input.subscriptionId ?? null, total, JSON.stringify(input.lineItems), input.memo, input.periodStart ?? null, input.dueAt, idempotencyKey, hash, orgId, input.customerId, input.subscriptionId ?? null, input.subscriptionId ?? null), { total }, [c.env.DB.prepare('UPDATE organizations SET invoice_counter=invoice_counter+1 WHERE id=?').bind(orgId)])
    } catch (e) {
      if (unique(e)) { const raced = await replay(c, 'invoices', orgId, idempotencyKey, hash); if (raced) return raced; throw conflict('An invoice already exists for this subscription period', 'duplicate_invoice') }
      if (conditionalFailure(e)) throw conflict('The customer or subscription changed', 'resource_changed')
      throw e
    }
    return c.json(await get(c, 'invoices', orgId, id), 201)
  })
  app.patch('/api/orgs/:orgId/invoices/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'invoices:write')
    const id = resourceId(c), input = await readBody(c, invoicePatch)
    someUpdate(input)
    await row(c, 'invoices', orgId, id)
    const total = input.lineItems ? invoiceTotal(input.lineItems) : null
    try {
      await mutate(c, orgId, auth.userId, 'invoices', id, 'invoice.updated', c.env.DB.prepare("UPDATE invoices SET line_items=COALESCE(?,line_items),total_amount=COALESCE(?,total_amount),due_at=COALESCE(?,due_at),memo=COALESCE(?,memo) WHERE org_id=? AND id=? AND status='draft'").bind(input.lineItems ? JSON.stringify(input.lineItems) : null, total, input.dueAt ?? null, input.memo ?? null, orgId, id), { fields: Object.keys(input) })
    } catch (e) { if (conditionalFailure(e)) throw conflict('Only draft invoices can be edited', 'not_draft'); throw e }
    return c.json(await get(c, 'invoices', orgId, id))
  })
  app.post('/api/orgs/:orgId/invoices/:id/finalize', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'invoices:write')
    const id = resourceId(c)
    await row(c, 'invoices', orgId, id)
    try { await mutate(c, orgId, auth.userId, 'invoices', id, 'invoice.finalized', c.env.DB.prepare("UPDATE invoices SET status='open',issued_at=? WHERE org_id=? AND id=? AND status='draft'").bind(nowIso(), orgId, id)) }
    catch (e) { if (conditionalFailure(e)) throw conflict('Only draft invoices can be finalized', 'not_draft'); throw e }
    return c.json(await get(c, 'invoices', orgId, id))
  })
  app.post('/api/orgs/:orgId/invoices/:id/void', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'invoices:write')
    const id = resourceId(c)
    await row(c, 'invoices', orgId, id)
    try {
      await mutate(c, orgId, auth.userId, 'invoices', id, 'invoice.voided', c.env.DB.prepare("UPDATE invoices SET status='void' WHERE org_id=? AND id=? AND status IN ('draft','open') AND NOT EXISTS (SELECT 1 FROM payments WHERE org_id=? AND invoice_id=? AND status IN ('pending','processing','succeeded')) AND NOT EXISTS (SELECT 1 FROM escrows WHERE org_id=? AND invoice_id=? AND status IN ('pending_funding','funded','disputed'))").bind(orgId, id, orgId, id, orgId, id))
    } catch (e) {
      if (conditionalFailure(e)) {
        if (await c.env.DB.prepare("SELECT id FROM payments WHERE org_id=? AND invoice_id=? AND status IN ('pending','processing','succeeded')").bind(orgId, id).first()) throw conflict('Cancel or resolve the payment on this invoice first', 'has_live_payment')
        if (await c.env.DB.prepare("SELECT id FROM escrows WHERE org_id=? AND invoice_id=? AND status IN ('pending_funding','funded','disputed')").bind(orgId, id).first()) throw conflict('Discard or resolve the escrow on this invoice first', 'has_live_escrow')
        throw conflict('Only draft or open invoices can be voided', 'not_voidable')
      }
      throw e
    }
    return c.json(await get(c, 'invoices', orgId, id))
  })
  app.delete('/api/orgs/:orgId/invoices/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'invoices:write')
    const id = resourceId(c)
    await row(c, 'invoices', orgId, id)
    try { await mutate(c, orgId, auth.userId, 'invoices', id, 'invoice.deleted', c.env.DB.prepare("DELETE FROM invoices WHERE org_id=? AND id=? AND status='draft'").bind(orgId, id)) }
    catch (e) { if (conditionalFailure(e)) throw conflict('Only draft invoices can be deleted. Void it instead.', 'not_draft'); if (String(e).includes('FOREIGN KEY')) throw conflict('This invoice is in use', 'in_use'); throw e }
    return c.body(null, 204)
  })
  for (const collection of ['payments', 'escrows'] as const) {
    app.post(`/api/orgs/:orgId/${collection}`, async c => {
      const { orgId, auth } = await requireWorkerOrg(c, collection === 'payments' ? 'payments:write' : 'escrows:write')
      const idempotencyKey = key(c)
      const input = collection === 'payments' ? await readBody(c, paymentBody) : await readBody(c, escrowBody)
      const hash = await stableHash(input)
      const prior = await replay(c, collection, orgId, idempotencyKey, hash)
      if (prior) return prior
      const invoice = await row(c, 'invoices', orgId, input.invoiceId)
      if (invoice.status !== 'open') throw conflict('Only open invoices can receive this record', 'invoice_not_open')
      const amount = collection === 'payments' ? (BigInt(String(invoice.total_amount)) - BigInt(String(invoice.amount_paid))).toString() : String(invoice.total_amount)
      if (BigInt(amount) <= 0n) throw conflict('The invoice has no remaining balance', 'invoice_not_open')
      const id = newId(), status = collection === 'payments' ? 'pending' : 'pending_funding'
      const releaseAfterDays = 'releaseAfterDays' in input ? input.releaseAfterDays : 0
      const statement = collection === 'payments'
        ? c.env.DB.prepare("INSERT INTO payments (id,org_id,invoice_id,customer_id,amount,chain_id,idempotency_key,request_hash) SELECT ?,org_id,id,customer_id,?,?,?,? FROM invoices WHERE org_id=? AND id=? AND status='open' AND total_amount=? AND amount_paid=?").bind(id, amount, Number(c.env.SIWE_CHAIN_ID), idempotencyKey, hash, orgId, input.invoiceId, String(invoice.total_amount), String(invoice.amount_paid))
        : c.env.DB.prepare("INSERT INTO escrows (id,org_id,invoice_id,customer_id,amount,release_after_days,chain_id,idempotency_key,request_hash) SELECT ?,org_id,id,customer_id,?,?,?,?,? FROM invoices WHERE org_id=? AND id=? AND status='open' AND total_amount=? AND amount_paid=?").bind(id, amount, releaseAfterDays, Number(c.env.SIWE_CHAIN_ID), idempotencyKey, hash, orgId, input.invoiceId, String(invoice.total_amount), String(invoice.amount_paid))
      try { await mutate(c, orgId, auth.userId, collection, id, `${singular[collection]}.created`, statement, { invoiceId: input.invoiceId, amount, status }) }
      catch (e) {
        if (unique(e)) { const raced = await replay(c, collection, orgId, idempotencyKey, hash); if (raced) return raced; throw conflict(`This invoice already has a live ${singular[collection]} record`, collection === 'payments' ? 'payment_exists' : 'escrow_exists') }
        if (conditionalFailure(e)) throw conflict('The invoice is no longer open or its balance changed', 'invoice_not_open')
        throw e
      }
      return c.json(await get(c, collection, orgId, id), 201)
    })
  }
  app.post('/api/orgs/:orgId/payments/:id/cancel', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'payments:write')
    const id = resourceId(c)
    await row(c, 'payments', orgId, id)
    try { await mutate(c, orgId, auth.userId, 'payments', id, 'payment.canceled', c.env.DB.prepare("UPDATE payments SET status='canceled' WHERE org_id=? AND id=? AND status='pending'").bind(orgId, id)) }
    catch (e) { if (conditionalFailure(e)) throw conflict('Only pending payments can be canceled', 'not_pending'); throw e }
    return c.json(await get(c, 'payments', orgId, id))
  })
  app.patch('/api/orgs/:orgId/escrows/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'escrows:write')
    const id = resourceId(c), input = await readBody(c, escrowPatch)
    await row(c, 'escrows', orgId, id)
    try { await mutate(c, orgId, auth.userId, 'escrows', id, 'escrow.terms_updated', c.env.DB.prepare("UPDATE escrows SET release_after_days=? WHERE org_id=? AND id=? AND status='pending_funding'").bind(input.releaseAfterDays, orgId, id), input) }
    catch (e) { if (conditionalFailure(e)) throw conflict('Terms can only change while the escrow is pending funding', 'not_pending_funding'); throw e }
    return c.json(await get(c, 'escrows', orgId, id))
  })
  app.delete('/api/orgs/:orgId/escrows/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'escrows:write')
    const id = resourceId(c)
    await row(c, 'escrows', orgId, id)
    try { await mutate(c, orgId, auth.userId, 'escrows', id, 'escrow.discarded', c.env.DB.prepare("DELETE FROM escrows WHERE org_id=? AND id=? AND status='pending_funding'").bind(orgId, id)) }
    catch (e) { if (conditionalFailure(e)) throw conflict('Only unfunded escrow records can be discarded', 'not_pending_funding'); if (String(e).includes('FOREIGN KEY')) throw conflict('This escrow is in use', 'in_use'); throw e }
    return c.body(null, 204)
  })
  app.get('/api/orgs/:orgId/escrows/:id/history', async c => {
    const { orgId } = await requireWorkerOrg(c, 'org:read')
    const id = resourceId(c)
    await row(c, 'escrows', orgId, id)
    const result = await c.env.DB.prepare("SELECT * FROM audit_logs WHERE org_id=? AND resource_type='escrow' AND resource_id=? ORDER BY created_at,id").bind(orgId, id).all<Row>()
    return c.json(result.results.map(r => ({ id: r.id, action: r.action, resourceType: r.resource_type, resourceId: r.resource_id, actorUserId: r.actor_user_id, actorType: r.actor_type, metadata: JSON.parse(String(r.metadata)) as unknown, createdAt: r.created_at })))
  })
}
