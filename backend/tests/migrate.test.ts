import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, type Db } from '../src/db/client'
import { migrate, resetTestDatabase } from '../src/db/migrate'
import { testConfig } from './helpers'

let db: Db
let url: string
beforeAll(() => {
  url = testConfig().databaseUrl
  db = createDb(url)
})
afterAll(async () => {
  await db.close()
})

const REQUIRED_TABLES = [
  'users', 'organizations', 'memberships', 'wallets', 'products', 'plans', 'customers', 'subscriptions', 'mandates',
  'invoices', 'escrows', 'payments', 'transactions', 'disputes', 'api_keys', 'webhooks', 'webhook_deliveries', 'audit_logs',
]

describe('migrations', () => {
  test('apply cleanly from an empty database and are idempotent', async () => {
    await resetTestDatabase(db, url)
    const first = await migrate(db)
    expect(first.applied.length).toBeGreaterThanOrEqual(7)
    const second = await migrate(db)
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual(first.applied)
  })

  test('every required table exists with UUID primary key, timestamps and no float money columns', async () => {
    const cols = (await db`
      SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'`) as { table_name: string; column_name: string; data_type: string }[]
    for (const table of REQUIRED_TABLES) {
      const mine = cols.filter((c) => c.table_name === table)
      expect(mine.length).toBeGreaterThan(0)
      expect(mine.find((c) => c.column_name === 'id')?.data_type).toBe('uuid')
      expect(mine.find((c) => c.column_name === 'created_at')).toBeDefined()
      expect(mine.find((c) => c.column_name === 'updated_at')).toBeDefined()
    }
    expect(cols.filter((c) => ['real', 'double precision', 'numeric'].includes(c.data_type))).toEqual([])
  })

  test('every tenant-owned table carries org_id', async () => {
    const tenantTables = ['memberships', 'products', 'plans', 'customers', 'subscriptions', 'mandates', 'invoices', 'escrows', 'payments', 'transactions', 'disputes', 'api_keys', 'webhooks', 'webhook_deliveries']
    const rows = (await db`
      SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'org_id'`) as { table_name: string }[]
    const withOrg = new Set(rows.map((r) => r.table_name))
    for (const t of tenantTables) expect(withOrg.has(t)).toBe(true)
  })

  test('updated_at is maintained by trigger', async () => {
    await db`INSERT INTO users (email, display_name) VALUES ('trigger@example.test', 'T')`
    const before = (await db`SELECT updated_at FROM users WHERE email = 'trigger@example.test'`) as { updated_at: Date }[]
    await Bun.sleep(15)
    await db`UPDATE users SET display_name = 'T2' WHERE email = 'trigger@example.test'`
    const after = (await db`SELECT updated_at FROM users WHERE email = 'trigger@example.test'`) as { updated_at: Date }[]
    expect(after[0].updated_at.getTime()).toBeGreaterThan(before[0].updated_at.getTime())
  })

  test('editing an already applied migration is detected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'))
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE IF NOT EXISTS mig_probe (id int);')
    await migrate(db, dir)
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE IF NOT EXISTS mig_probe (id int, extra int);')
    await expect(migrate(db, dir)).rejects.toThrow(/modified after it was applied/)
    await db`DROP TABLE IF EXISTS mig_probe`
    await db`DELETE FROM schema_migrations WHERE name = '0001_a.sql'`
  })

  test('a failing migration rolls back completely', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'))
    await writeFile(join(dir, '0099_bad.sql'), 'CREATE TABLE rollback_probe (id int); SELECT 1/0;')
    await expect(migrate(db, dir)).rejects.toThrow()
    const rows = await db`SELECT to_regclass('public.rollback_probe') AS t`
    expect((rows as { t: string | null }[])[0].t).toBeNull()
  })

  test('refuses to reset a database that is not named *_test', async () => {
    await expect(resetTestDatabase(db, 'postgres://u:p@127.0.0.1:5432/retempo')).rejects.toThrow(/only \*_test/)
  })
})
