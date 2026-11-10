import { sql } from 'drizzle-orm'
import { registerChainRoutes } from './chain/routes'
import { registerAuthRoutes } from './auth/routes'
import { resolveAuth } from './auth/sessions'
import { registerCatalogRoutes } from './catalog/routes'
import { registerBillingRoutes } from './billing/routes'
import { createOrm } from './db/client'
import { createHttpApp } from './http'
import type { WorkerBindings } from './types'

export function createWorkerApp() {
  const app = createHttpApp({ resolveAuth })
  app.get('/api/health', async (c) => {
    await createOrm(c.env.DB).get(sql`SELECT 1 AS ready`)
    return c.json({ ok: true, runtime: 'cloudflare-workers', database: 'd1' })
  })
  registerAuthRoutes(app)
  registerCatalogRoutes(app)
  registerChainRoutes(app)
  registerBillingRoutes(app)
  return app
}

const app = createWorkerApp()
export default {
  async fetch(request: Request, env: WorkerBindings): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/api' || path.startsWith('/api/')) return app.fetch(request, env)
    if (env.ASSETS) return env.ASSETS.fetch(request)
    return new Response('Not found', { status: 404 })
  },
}
