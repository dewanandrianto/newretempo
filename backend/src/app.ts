import { createMailer, type Mailer } from './auth/mailer'
import { loadConfig, type Config } from './config'
import { createDb, type Db } from './db/client'
import { createApp, type App } from './http/app'
import { RateLimiter } from './http/rateLimit'
import { authRoutes } from './routes/auth'
import { orgRoutes } from './routes/orgs'

export interface BuildOptions {
  config: Config
  db: Db
  mailer?: Mailer
  limiter?: RateLimiter
  now?: () => Date
}

/** Assembles the API from explicit dependencies, so tests can inject a database, mailer and clock. */
export function buildApp(options: BuildOptions): App {
  return createApp(
    {
      config: options.config,
      db: options.db,
      mailer: options.mailer ?? createMailer(options.config),
      limiter: options.limiter ?? new RateLimiter(),
      now: options.now ?? (() => new Date()),
    },
    (router) => {
      authRoutes(router)
      orgRoutes(router)
    },
  )
}

export function buildAppFromEnv(): { app: App; config: Config; db: Db } {
  const config = loadConfig()
  const db = createDb(config.databaseUrl)
  return { app: buildApp({ config, db }), config, db }
}
