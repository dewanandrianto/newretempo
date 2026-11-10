import { z } from 'zod'
import { requireAuth, requireOrg, resourceId } from '../http/guards'
import type { Router } from '../http/router'
import { created, noContent, Reply, type Ctx } from '../http/types'
import { loadAccount } from '../services/account'
import { createApiKey, apiKeyBody, listApiKeys, listAuditLogs, revokeApiKey } from '../services/apiKeys'
import { createProduct, createPlan, deletePlan, deleteProduct, getPlan, getProduct, listPlans, listProducts, planBody, planPatch, productBody, productPatch, updatePlan, updateProduct } from '../services/catalog'
import { idempotencyKey, listQuery } from '../services/common'
import { createCustomer, customerBody, customerPatch, deleteCustomer, getCustomer, listCustomers, updateCustomer } from '../services/customers'
import { createEscrow, deleteEscrow, escrowBody, escrowHistory, escrowPatch, getEscrow, listEscrows, updateEscrow } from '../services/escrows'
import { createInvoice, deleteInvoice, finalizeInvoice, getInvoice, invoiceBody, invoicePatch, listInvoices, updateInvoice, voidInvoice } from '../services/invoices'
import { addMember, addMemberBody, changeMemberRole, listMembers, removeMember, updateMemberBody } from '../services/members'
import { createOrganization, createOrgBody, getOrganization, updateOrganization, updateOrgBody } from '../services/orgs'
import { cancelPayment, createPayment, getPayment, listPayments, paymentBody } from '../services/payments'
import { createSubscription, deleteSubscription, getSubscription, listSubscriptions, subscriptionBody, subscriptionPatch, updateSubscription } from '../services/subscriptions'
import { createWallet, deleteWallet, listWallets, updateWallet, walletBody, walletPatch } from '../services/wallets'

const page = (ctx: Ctx) => ctx.query(listQuery)

/** 201 for a fresh create, 200 for an idempotent replay of an earlier identical request. */
function idempotentReply(data: unknown, replayed: boolean): Reply {
  return new Reply(replayed ? 200 : 201, data)
}

export function orgRoutes(r: Router): void {
  // ---- organizations -------------------------------------------------------
  r.get('/api/orgs', async (ctx) => (await loadAccount(ctx.deps.db, requireAuth(ctx).userId)).memberships)
  r.post('/api/orgs', async (ctx) => {
    const auth = requireAuth(ctx)
    return created(await createOrganization(ctx, auth, await ctx.body(createOrgBody)))
  })
  r.get('/api/orgs/:orgId', async (ctx) => {
    const { orgId } = await requireOrg(ctx, 'org:read')
    return getOrganization(ctx, orgId)
  })
  r.patch('/api/orgs/:orgId', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'org:update')
    return updateOrganization(ctx, orgId, auth.userId, await ctx.body(updateOrgBody))
  })

  // ---- members -------------------------------------------------------------
  r.get('/api/orgs/:orgId/members', async (ctx) => {
    const { orgId } = await requireOrg(ctx, 'members:read')
    return listMembers(ctx, orgId)
  })
  r.post('/api/orgs/:orgId/members', async (ctx) => {
    const { orgId, auth, role } = await requireOrg(ctx, 'members:manage')
    return created(await addMember(ctx, orgId, { id: auth.userId, role }, await ctx.body(addMemberBody)))
  })
  r.patch('/api/orgs/:orgId/members/:userId', async (ctx) => {
    const { orgId, auth, role } = await requireOrg(ctx, 'members:manage')
    const { role: next } = await ctx.body(updateMemberBody)
    return changeMemberRole(ctx, orgId, { id: auth.userId, role }, resourceId(ctx, 'userId'), next)
  })
  r.delete('/api/orgs/:orgId/members/:userId', async (ctx) => {
    // Any member may remove themselves; removing others needs members:manage (checked in the service).
    const { orgId, auth, role } = await requireOrg(ctx, 'org:read')
    const target = resourceId(ctx, 'userId')
    if (target !== auth.userId) await requireOrg(ctx, 'members:manage')
    await removeMember(ctx, orgId, { id: auth.userId, role }, target)
    return noContent()
  })

  // ---- products ------------------------------------------------------------
  r.get('/api/orgs/:orgId/products', async (ctx) => listProducts(ctx, (await requireOrg(ctx, 'org:read')).orgId, page(ctx)))
  r.post('/api/orgs/:orgId/products', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'catalog:write')
    return created(await createProduct(ctx, orgId, auth.userId, await ctx.body(productBody)))
  })
  r.get('/api/orgs/:orgId/products/:id', async (ctx) => getProduct(ctx, (await requireOrg(ctx, 'org:read')).orgId, resourceId(ctx)))
  r.patch('/api/orgs/:orgId/products/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'catalog:write')
    return updateProduct(ctx, orgId, auth.userId, resourceId(ctx), await ctx.body(productPatch))
  })
  r.delete('/api/orgs/:orgId/products/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'catalog:write')
    await deleteProduct(ctx, orgId, auth.userId, resourceId(ctx))
    return noContent()
  })

  // ---- plans ---------------------------------------------------------------
  r.get('/api/orgs/:orgId/plans', async (ctx) => listPlans(ctx, (await requireOrg(ctx, 'org:read')).orgId, page(ctx)))
  r.post('/api/orgs/:orgId/plans', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'catalog:write')
    return created(await createPlan(ctx, orgId, auth.userId, await ctx.body(planBody)))
  })
  r.get('/api/orgs/:orgId/plans/:id', async (ctx) => getPlan(ctx, (await requireOrg(ctx, 'org:read')).orgId, resourceId(ctx)))
  r.patch('/api/orgs/:orgId/plans/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'catalog:write')
    return updatePlan(ctx, orgId, auth.userId, resourceId(ctx), await ctx.body(planPatch))
  })
  r.delete('/api/orgs/:orgId/plans/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'catalog:write')
    await deletePlan(ctx, orgId, auth.userId, resourceId(ctx))
    return noContent()
  })

  // ---- customers -----------------------------------------------------------
  r.get('/api/orgs/:orgId/customers', async (ctx) => listCustomers(ctx, (await requireOrg(ctx, 'org:read')).orgId, page(ctx)))
  r.post('/api/orgs/:orgId/customers', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'customers:write')
    return created(await createCustomer(ctx, orgId, auth.userId, await ctx.body(customerBody)))
  })
  r.get('/api/orgs/:orgId/customers/:id', async (ctx) => getCustomer(ctx, (await requireOrg(ctx, 'org:read')).orgId, resourceId(ctx)))
  r.patch('/api/orgs/:orgId/customers/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'customers:write')
    return updateCustomer(ctx, orgId, auth.userId, resourceId(ctx), await ctx.body(customerPatch))
  })
  r.delete('/api/orgs/:orgId/customers/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'catalog:write')
    await deleteCustomer(ctx, orgId, auth.userId, resourceId(ctx))
    return noContent()
  })

  // ---- subscriptions -------------------------------------------------------
  r.get('/api/orgs/:orgId/subscriptions', async (ctx) => listSubscriptions(ctx, (await requireOrg(ctx, 'org:read')).orgId, page(ctx)))
  r.post('/api/orgs/:orgId/subscriptions', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'subscriptions:write')
    return created(await createSubscription(ctx, orgId, auth.userId, await ctx.body(subscriptionBody)))
  })
  r.get('/api/orgs/:orgId/subscriptions/:id', async (ctx) => getSubscription(ctx, (await requireOrg(ctx, 'org:read')).orgId, resourceId(ctx)))
  r.patch('/api/orgs/:orgId/subscriptions/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'subscriptions:write')
    return updateSubscription(ctx, orgId, auth.userId, resourceId(ctx), await ctx.body(subscriptionPatch))
  })
  r.delete('/api/orgs/:orgId/subscriptions/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'subscriptions:write')
    await deleteSubscription(ctx, orgId, auth.userId, resourceId(ctx))
    return noContent()
  })

  // ---- invoices ------------------------------------------------------------
  r.get('/api/orgs/:orgId/invoices', async (ctx) => listInvoices(ctx, (await requireOrg(ctx, 'org:read')).orgId, page(ctx)))
  r.post('/api/orgs/:orgId/invoices', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'invoices:write')
    const { invoice, replayed } = await createInvoice(ctx, orgId, auth.userId, idempotencyKey(ctx), await ctx.body(invoiceBody))
    return idempotentReply(invoice, replayed)
  })
  r.get('/api/orgs/:orgId/invoices/:id', async (ctx) => getInvoice(ctx, (await requireOrg(ctx, 'org:read')).orgId, resourceId(ctx)))
  r.patch('/api/orgs/:orgId/invoices/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'invoices:write')
    return updateInvoice(ctx, orgId, auth.userId, resourceId(ctx), await ctx.body(invoicePatch))
  })
  r.post('/api/orgs/:orgId/invoices/:id/finalize', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'invoices:write')
    return finalizeInvoice(ctx, orgId, auth.userId, resourceId(ctx))
  })
  r.post('/api/orgs/:orgId/invoices/:id/void', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'invoices:write')
    return voidInvoice(ctx, orgId, auth.userId, resourceId(ctx))
  })
  r.delete('/api/orgs/:orgId/invoices/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'invoices:write')
    await deleteInvoice(ctx, orgId, auth.userId, resourceId(ctx))
    return noContent()
  })

  // ---- payment records -----------------------------------------------------
  r.get('/api/orgs/:orgId/payments', async (ctx) => listPayments(ctx, (await requireOrg(ctx, 'org:read')).orgId, page(ctx)))
  r.post('/api/orgs/:orgId/payments', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'payments:write')
    const { payment, replayed } = await createPayment(ctx, orgId, auth.userId, idempotencyKey(ctx), await ctx.body(paymentBody))
    return idempotentReply(payment, replayed)
  })
  r.get('/api/orgs/:orgId/payments/:id', async (ctx) => getPayment(ctx, (await requireOrg(ctx, 'org:read')).orgId, resourceId(ctx)))
  r.post('/api/orgs/:orgId/payments/:id/cancel', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'payments:write')
    return cancelPayment(ctx, orgId, auth.userId, resourceId(ctx))
  })

  // ---- escrow records (create / read / discard only; status is chain-controlled) ----
  r.get('/api/orgs/:orgId/escrows', async (ctx) => listEscrows(ctx, (await requireOrg(ctx, 'org:read')).orgId, page(ctx)))
  r.post('/api/orgs/:orgId/escrows', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'escrows:write')
    const { escrow, replayed } = await createEscrow(ctx, orgId, auth.userId, idempotencyKey(ctx), await ctx.body(escrowBody))
    return idempotentReply(escrow, replayed)
  })
  r.get('/api/orgs/:orgId/escrows/:id', async (ctx) => getEscrow(ctx, (await requireOrg(ctx, 'org:read')).orgId, resourceId(ctx)))
  r.get('/api/orgs/:orgId/escrows/:id/history', async (ctx) => escrowHistory(ctx, (await requireOrg(ctx, 'org:read')).orgId, resourceId(ctx)))
  r.patch('/api/orgs/:orgId/escrows/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'escrows:write')
    return updateEscrow(ctx, orgId, auth.userId, resourceId(ctx), await ctx.body(escrowPatch))
  })
  r.delete('/api/orgs/:orgId/escrows/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'escrows:write')
    await deleteEscrow(ctx, orgId, auth.userId, resourceId(ctx))
    return noContent()
  })

  // ---- wallet associations -------------------------------------------------
  r.get('/api/orgs/:orgId/wallets', async (ctx) => listWallets(ctx, (await requireOrg(ctx, 'org:read')).orgId))
  r.post('/api/orgs/:orgId/wallets', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'wallets:write')
    return created(await createWallet(ctx, orgId, auth.userId, await ctx.body(walletBody)))
  })
  r.patch('/api/orgs/:orgId/wallets/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'wallets:write')
    return updateWallet(ctx, orgId, auth.userId, resourceId(ctx), await ctx.body(walletPatch))
  })
  r.delete('/api/orgs/:orgId/wallets/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'wallets:write')
    await deleteWallet(ctx, orgId, auth.userId, resourceId(ctx))
    return noContent()
  })

  // ---- API keys and audit trail ----------------------------------------------
  r.get('/api/orgs/:orgId/api-keys', async (ctx) => listApiKeys(ctx, (await requireOrg(ctx, 'api_keys:manage')).orgId))
  r.post('/api/orgs/:orgId/api-keys', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'api_keys:manage')
    return created(await createApiKey(ctx, orgId, auth.userId, await ctx.body(apiKeyBody)))
  })
  r.delete('/api/orgs/:orgId/api-keys/:id', async (ctx) => {
    const { orgId, auth } = await requireOrg(ctx, 'api_keys:manage')
    await revokeApiKey(ctx, orgId, auth.userId, resourceId(ctx))
    return noContent()
  })
  r.get('/api/orgs/:orgId/audit-logs', async (ctx) => {
    const { orgId } = await requireOrg(ctx, 'api_keys:manage')
    const q = ctx.query(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }))
    return listAuditLogs(ctx, orgId, q.limit, q.offset)
  })
}
