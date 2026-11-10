import { buildAppFromEnv } from './app'
import { ConfigError } from './config'

try {
  const { app, config, db } = buildAppFromEnv()
  const server = Bun.serve({
    port: config.port,
    hostname: '127.0.0.1',
    maxRequestBodySize: 512 * 1024,
    fetch: (req, srv) => app.fetch(req, srv.requestIP(req)?.address),
  })
  console.info(`RETEMPO API listening on http://127.0.0.1:${server.port} (${config.env})`)
  if (config.emailMode === 'log') console.info('Email mode: development log (links are printed here, never sent)')
  if (config.isProduction) console.info('Production mode: development email logging is disabled')

  const shutdown = () => {
    void server.stop()
    void db.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err)
  process.exit(1)
}
