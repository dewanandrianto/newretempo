import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { createOrm } from '../db/client'
import { customers, products } from '../db/schema'
import type { Context } from 'hono'
import type { ApiProduct, ApiPlan, ApiCustomer } from '../../../shared/types/api'
import { parseBaseUnits } from '../../../shared/money'
import type { WorkerApp, WorkerContext } from '../types'
import { requireWorkerOrg, resourceId } from '../auth/guards'
import { newId, nowIso, parsePage, uuid } from '../common'
import { readBody } from '../http'
import { notFound } from '../errors'
import { insert, update, mutate, mapConstraint } from './db'

type C = Context<WorkerContext>
const text = (max: number) => z.string().trim().min(1).max(max)
const status = z.enum(['active', 'archived'])
const amount = z.string().transform((s, ctx) => {
  try { const n = parseBaseUnits(s); if (n === 0n) throw new Error('Amount must be greater than zero'); return n.toString() }
  catch (e) { ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : 'Invalid amount' }); return z.NEVER }
})
const productBody = z.object({ name: text(120), description: z.string().trim().max(1000).default('') })
const productPatch = z.object({ name: text(120).optional(), description: z.string().trim().max(1000).optional(), status: status.optional() })
const planBody = z.object({ productId: uuid, name: text(120), amount, interval: z.enum(['week', 'month', 'year']), trialDays: z.number().int().min(0).max(365).default(0), escrowDays: z.number().int().min(0).max(90).default(0) })
const planPatch = z.object({ name: text(120).optional(), amount: amount.optional(), trialDays: z.number().int().min(0).max(365).optional(), escrowDays: z.number().int().min(0).max(90).optional(), status: status.optional() })
const email = z.string().trim().toLowerCase().max(254).pipe(z.email())
const customerBody = z.object({ name: text(120), email, company: z.string().trim().max(120).default('') })
const customerPatch = z.object({ name: text(120).optional(), email: email.optional(), company: z.string().trim().max(120).optional(), status: status.optional() })
interface ProductRow { id: string; name: string; description: string; status: ApiProduct['status']; plan_count: number; created_at: string; updated_at: string }
interface PlanRow { id: string; product_id: string; product_name: string; name: string; amount: string; interval: ApiPlan['interval']; trial_days: number; escrow_days: number; status: ApiPlan['status']; subscriber_count: number; created_at: string }
interface CustomerRow { id: string; name: string; email: string; company: string; status: ApiCustomer['status']; created_at: string }
const productSelect = 'SELECT p.*, (SELECT count(*) FROM plans pl WHERE pl.org_id=p.org_id AND pl.product_id=p.id) AS plan_count FROM products p WHERE p.org_id=?'
const planSelect = "SELECT p.*,pr.name AS product_name,(SELECT count(*) FROM subscriptions s WHERE s.org_id=p.org_id AND s.plan_id=p.id AND s.status<>'canceled') AS subscriber_count FROM plans p JOIN products pr ON pr.org_id=p.org_id AND pr.id=p.product_id WHERE p.org_id=?"
const toProduct = (r: ProductRow): ApiProduct => ({ id: r.id, name: r.name, description: r.description, status: r.status, planCount: r.plan_count, createdAt: r.created_at, updatedAt: r.updated_at })
const toPlan = (r: PlanRow): ApiPlan => ({ id: r.id, productId: r.product_id, productName: r.product_name, name: r.name, amount: r.amount, interval: r.interval, trialDays: r.trial_days, escrowDays: r.escrow_days, status: r.status, subscriberCount: r.subscriber_count, createdAt: r.created_at })
const toCustomer = (r: CustomerRow): ApiCustomer => ({ id: r.id, name: r.name, email: r.email, company: r.company, status: r.status, createdAt: r.created_at })
async function getProduct(c: C, org: string, id: string) { const r = await c.env.DB.prepare(productSelect + ' AND p.id=?').bind(org, id).first<ProductRow>(); if (!r) throw notFound('Product'); return toProduct(r) }
async function getPlan(c: C, org: string, id: string) { const r = await c.env.DB.prepare(planSelect + ' AND p.id=?').bind(org, id).first<PlanRow>(); if (!r) throw notFound('Plan'); return toPlan(r) }
async function getCustomer(c: C, org: string, id: string) {
  const row = await createOrm(c.env.DB).select().from(customers).where(and(eq(customers.org_id, org), eq(customers.id, id))).get()
  if (!row) throw notFound('Customer')
  return toCustomer(row as CustomerRow)
}
export function registerResources(app: WorkerApp) {
  app.get('/api/orgs/:orgId/products', async c => { const { orgId } = await requireWorkerOrg(c, 'org:read'); const p = parsePage(c); return c.json((await c.env.DB.prepare(productSelect + ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?').bind(orgId, p.limit, p.offset).all<ProductRow>()).results.map(toProduct)) })
  app.get('/api/orgs/:orgId/products/:id', async c => c.json(await getProduct(c, (await requireWorkerOrg(c, 'org:read')).orgId, resourceId(c))))
  app.post('/api/orgs/:orgId/products', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'catalog:write'), input = await readBody(c, productBody), id = newId(), now = nowIso()
    try { await insert(c, 'products', { id, org_id: orgId, ...input, created_at: now, updated_at: now }, auth.userId, orgId, 'product.created', 'product', id) }
    catch (e) { mapConstraint(e, 'A product with this name already exists', 'duplicate_name') }
    return c.json(await getProduct(c, orgId, id), 201)
  })
  app.patch('/api/orgs/:orgId/products/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'catalog:write'), id = resourceId(c), patch = await readBody(c, productPatch)
    try { await update(c, 'products', orgId, id, patch, auth.userId, 'product') } catch (e) { mapConstraint(e, 'A product with this name already exists', 'duplicate_name') }
    return c.json(await getProduct(c, orgId, id))
  })
  app.delete('/api/orgs/:orgId/products/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'catalog:write'), id = resourceId(c)
    try { await mutate(c, c.env.DB.prepare('DELETE FROM products WHERE org_id=? AND id=?').bind(orgId, id), auth.userId, orgId, 'product.deleted', 'product', id) } catch (e) { mapConstraint(e, '', '', 'Archive this product instead: it still has plans') }
    return c.body(null, 204)
  })
  app.get('/api/orgs/:orgId/plans', async c => { const { orgId } = await requireWorkerOrg(c, 'org:read'); const p = parsePage(c); return c.json((await c.env.DB.prepare(planSelect + ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?').bind(orgId, p.limit, p.offset).all<PlanRow>()).results.map(toPlan)) })
  app.get('/api/orgs/:orgId/plans/:id', async c => c.json(await getPlan(c, (await requireWorkerOrg(c, 'org:read')).orgId, resourceId(c))))
  app.post('/api/orgs/:orgId/plans', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'catalog:write'), input = await readBody(c, planBody), id = newId(), now = nowIso()
    if (!await createOrm(c.env.DB).select({ id: products.id }).from(products).where(and(eq(products.org_id, orgId), eq(products.id, input.productId), eq(products.status, 'active'))).get()) throw notFound('Product')
    try { await insert(c, 'plans', { id, org_id: orgId, product_id: input.productId, name: input.name, amount: input.amount, interval: input.interval, trial_days: input.trialDays, escrow_days: input.escrowDays, created_at: now, updated_at: now }, auth.userId, orgId, 'plan.created', 'plan', id, { amount: input.amount, interval: input.interval }) }
    catch (e) { mapConstraint(e, 'This product already has a plan with that name', 'duplicate_name') }
    return c.json(await getPlan(c, orgId, id), 201)
  })
  app.patch('/api/orgs/:orgId/plans/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'catalog:write'), id = resourceId(c), patch = await readBody(c, planPatch)
    const { trialDays, escrowDays, ...rest } = patch
    try { await update(c, 'plans', orgId, id, { ...rest, ...(trialDays !== undefined ? { trial_days: trialDays } : {}), ...(escrowDays !== undefined ? { escrow_days: escrowDays } : {}) }, auth.userId, 'plan') }
    catch (e) { mapConstraint(e, 'This product already has a plan with that name', 'duplicate_name') }
    return c.json(await getPlan(c, orgId, id))
  })
  app.delete('/api/orgs/:orgId/plans/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'catalog:write'), id = resourceId(c)
    try { await mutate(c, c.env.DB.prepare('DELETE FROM plans WHERE org_id=? AND id=?').bind(orgId, id), auth.userId, orgId, 'plan.deleted', 'plan', id) } catch (e) { mapConstraint(e, '', '', 'Archive this plan instead: subscriptions use it') }
    return c.body(null, 204)
  })
  app.get('/api/orgs/:orgId/customers', async c => {
    const { orgId } = await requireWorkerOrg(c, 'org:read'), page = parsePage(c)
    const rows = await createOrm(c.env.DB).select().from(customers).where(eq(customers.org_id, orgId)).orderBy(desc(customers.created_at)).limit(page.limit).offset(page.offset).all()
    return c.json(rows.map(row => toCustomer(row as CustomerRow)))
  })
  app.get('/api/orgs/:orgId/customers/:id', async c => c.json(await getCustomer(c, (await requireWorkerOrg(c, 'org:read')).orgId, resourceId(c))))
  app.post('/api/orgs/:orgId/customers', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'customers:write'), input = await readBody(c, customerBody), id = newId(), now = nowIso()
    try { await insert(c, 'customers', { id, org_id: orgId, ...input, created_at: now, updated_at: now }, auth.userId, orgId, 'customer.created', 'customer', id) } catch (e) { mapConstraint(e, 'A customer with this email already exists', 'duplicate_email') }
    return c.json(await getCustomer(c, orgId, id), 201)
  })
  app.patch('/api/orgs/:orgId/customers/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'customers:write'), id = resourceId(c), patch = await readBody(c, customerPatch)
    try { await update(c, 'customers', orgId, id, patch, auth.userId, 'customer') } catch (e) { mapConstraint(e, 'A customer with this email already exists', 'duplicate_email') }
    return c.json(await getCustomer(c, orgId, id))
  })
  app.delete('/api/orgs/:orgId/customers/:id', async c => {
    const { orgId, auth } = await requireWorkerOrg(c, 'catalog:write'), id = resourceId(c)
    try { await mutate(c, c.env.DB.prepare('DELETE FROM customers WHERE org_id=? AND id=?').bind(orgId, id), auth.userId, orgId, 'customer.deleted', 'customer', id) } catch (e) { mapConstraint(e, '', '', 'Archive this customer instead: they have subscriptions or invoices') }
    return c.body(null, 204)
  })
}
