import { SQL } from 'bun'

/** A pool or an open transaction. Services accept either so they compose inside `withTx`. */
export type Db = SQL

export function createDb(url: string): SQL {
  return new SQL(url, { max: 10, idleTimeout: 30, connectionTimeout: 10 })
}

/**
 * Runs `fn` inside a database transaction. Everything commits together or rolls back
 * on any thrown error. Use for every multi-statement write.
 */
export async function withTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return (await db.begin(async (tx) => fn(tx as Db))) as T
}

/** Postgres error helpers (SQLSTATE codes). */
export function pgCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const rec = err as Record<string, unknown>
    const code = rec.errno ?? rec.code
    if (typeof code === 'string') return code
  }
  return undefined
}

export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  insufficientPrivilege: '42501',
} as const

/** Constraint name from a Postgres error, when the driver exposes it. */
export function pgConstraint(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const c = (err as Record<string, unknown>).constraint
    if (typeof c === 'string') return c
  }
  return undefined
}
