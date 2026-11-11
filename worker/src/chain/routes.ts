import { z } from 'zod'
import { readBody } from '../http'
import type { WorkerApp } from '../types'
import { requireWorkerAuth, requireWorkerOrg } from '../auth/guards'
import { consumeRateLimit } from '../auth/rateLimits'
import { configuration, snapshot, sync, configuredConfiguration, enabledConfiguration, walletSnapshot } from './client'
import { preparePlan, verifiedWallet, address } from './plans'
import { badRequest } from '../errors'
import { createCheckout, publicCheckout } from './checkouts'
import { prepareCheckout } from './prepare'
import { customerSnapshot, customerSnapshotPage } from './customer'
export function historyToken(c: { req: { query: (name: string) => string | undefined } }): string | undefined {
  const token = c.req.query('pageToken')
  if (token !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) throw badRequest('Invalid history page token')
  return token
}
export function registerChainRoutes(app: WorkerApp) {
  app.get('/api/wallet/chain/snapshot', async c => {
    requireWorkerAuth(c)
    const requested = c.req.query('wallet')
    const parsed = requested === undefined ? undefined : address.safeParse(requested)
    if (parsed && !parsed.success) throw badRequest('A valid wallet address is required')
    const wallet = await verifiedWallet(c, parsed?.success ? parsed.data : undefined)
    c.header('Cache-Control', 'no-store')
    return c.json(await walletSnapshot(c.env, wallet, historyToken(c)))
  })
  app.get('/api/customer/chain/snapshot', customerSnapshot)
  app.get('/api/customer/chain/snapshot/pages', customerSnapshotPage)
  app.post('/api/public/checkouts/:token/prepare', prepareCheckout)
  app.post('/api/orgs/:orgId/chain/checkouts', async c => {
    await enabledConfiguration(c.env)
    return createCheckout(c)
  })
  app.get('/api/public/checkouts/:token', publicCheckout)
  app.get('/api/public/invoices/:token', publicCheckout)
  app.post('/api/orgs/:orgId/chain/plans/:planId/prepare', preparePlan)
  app.get('/api/chain/config', async c => c.json(await configuration(c.env)))
  app.post('/api/chain/sync', async c => {
    const auth = requireWorkerAuth(c)
    await readBody(c, z.object({}).strict())
    await consumeRateLimit(c.env.DB, `chain:sync:${auth.userId}`, 5, 60000)
    await configuredConfiguration(c.env)
    return c.json(await sync(c.env))
  })
  app.get('/api/orgs/:orgId/chain/snapshot', async c => {
    const { orgId } = await requireWorkerOrg(c, 'org:read')
    c.header('Cache-Control', 'no-store')
    return c.json(await snapshot(c.env, orgId, historyToken(c)))
  })
}
