import type { Context } from 'hono'
import { z } from 'zod'
import { MoneyError, parseBaseUnits } from '../../shared/money'
import { badRequest, conflict, validationFailed } from './errors'
import type { WorkerContext } from './types'

export const uuid = z.uuid()
export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})
export const parsePage = (c: Context<WorkerContext>) => listQuery.parse(c.req.query())
export const nowIso = () => new Date().toISOString()
export const newId = () => crypto.randomUUID()
export const isoDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString())
export const evmAddress = z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, 'Enter a valid 0x wallet address').transform((value) => value.toLowerCase())
export const shortText = (max: number, min = 1) => z.string().trim().min(min).max(max)
export const positiveBaseUnits = z.string().transform((value, ctx) => {
  try {
    const amount = parseBaseUnits(value)
    if (amount <= 0n) throw new MoneyError('Amount must be greater than zero')
    return amount
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid amount' })
    return z.NEVER
  }
})

function canonical(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  }
  return value
}
export async function stableHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export const requestHash = stableHash
export function idempotencyKey(c: Context<WorkerContext>): string {
  const key = c.req.header('Idempotency-Key')
  if (!key || !/^[A-Za-z0-9_\-:.]{8,128}$/.test(key)) {
    throw validationFailed({ 'Idempotency-Key': 'Send an Idempotency-Key header with 8-128 letters, numbers, dashes or underscores' })
  }
  return key
}
export function sameRequestOrThrow(existing: string, incoming: string): void {
  if (existing !== incoming) throw conflict('This Idempotency-Key was already used with a different request', 'idempotency_key_reused')
}
export function assertSomeUpdate(patch: Record<string, unknown>): void {
  if (Object.values(patch).every((value) => value === undefined)) throw badRequest('Send at least one field to update')
}
