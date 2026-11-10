import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDb, type Db } from './client'

const MIGRATIONS_DIR = join(import.meta.dir, '../../../database/migrations')

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

/**
 * Applies pending SQL files from database/migrations in filename order.
 * - Each file runs in its own transaction.
 * - Applied files are checksummed; editing an applied migration is an error.
 * - A Postgres advisory lock stops two processes migrating at once.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`).simple()

  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
  const result: MigrationResult = { applied: [], skipped: [] }

  for (const name of files) {
    const text = await readFile(join(dir, name), 'utf8')
    const checksum = createHash('sha256').update(text).digest('hex')

    await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(727274)`
      const rows = await tx`SELECT checksum FROM schema_migrations WHERE name = ${name}`
      const existing = rows[0] as { checksum: string } | undefined
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(`Migration ${name} was modified after it was applied. Add a new migration instead.`)
        }
        result.skipped.push(name)
        return
      }
      await tx.unsafe(text).simple()
      await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${name}, ${checksum})`
      result.applied.push(name)
    })
  }
  return result
}

/** Drops everything in the public schema. Refuses to run unless the database name ends in _test. */
export async function resetTestDatabase(db: Db, url: string): Promise<void> {
  const dbName = new URL(url).pathname.replace(/^\//, '')
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to reset "${dbName}": only *_test databases can be reset`)
  await db.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;').simple()
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set')
    process.exit(1)
  }
  const db = createDb(url)
  try {
    const { applied, skipped } = await migrate(db)
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.')
    if (skipped.length) console.log(`Already applied: ${skipped.length}`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  } finally {
    await db.close()
  }
}
