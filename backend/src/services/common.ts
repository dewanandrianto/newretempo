import { z } from 'zod'
import { MoneyError, parseBaseUnits } from '@shared/money'
import { badRequest, conflict, validationFailed } from '../http/errors'
import type { Ctx } from '../http/types'
import { sha256Hex } from '../security/crypto'

/** USDC base-unit integer string -> bigint, positive and within BIGINT range. */
export const positiveBaseUnits = z.string().transform((value, ctx) => {
  try {
    const n = parseBaseUnits(value)
    if (n <= 0n) throw new MoneyError('Amount must be greater than zero')
    return n
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: err instanceof MoneyError ? err.message : 'Invalid amount' })
    return z.NEVER
  }
})

export const uuid = z.uuid()
export const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s))
export const evmAddress = z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, 'Enter a valid 0x wallet address').transform((s) => s.toLowerCase())
export const shortText = (max: number, min = 1) => z.string().trim().min(min).max(max)

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})

/** Deterministic hash of the semantic request, used to detect an idempotency key reused with a different body. */
export function requestHash(value: unknown): string {
  return sha256Hex(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)))
}

const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/

/** Financial create operations must carry an Idempotency-Key so retries can never double-create. */
export function idempotencyKey(ctx: Ctx): string {
  const key = ctx.req.headers.get('idempotency-key')
  if (!key) throw validationFailed({ 'Idempotency-Key': 'Send an Idempotency-Key header (8-128 characters) with this request' })
  if (!KEY_PATTERN.test(key)) throw validationFailed({ 'Idempotency-Key': 'Use 8-128 letters, numbers, dashes or underscores' })
  return key
}

export function sameRequestOrThrow(existingHash: string, newHash: string): void {
  if (existingHash !== newHash) {
    throw conflict('This Idempotency-Key was already used with a different request', 'idempotency_key_reused')
  }
}

export function assertSomeUpdate(patch: Record<string, unknown>): void {
  if (Object.values(patch).every((v) => v === undefined)) throw badRequest('Send at least one field to update')
}

export interface Page {
  limit: number
  offset: number
}

export const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString())
