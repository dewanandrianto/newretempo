import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'
import type { D1Migration } from '@cloudflare/vitest-plugin'

beforeAll(async () => {
  const bindings = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS)
})
