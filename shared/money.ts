/**
 * USDC money helpers shared by the API and the web app.
 * Rules: amounts are integer base units (6 decimals) held in bigint or in a decimal
 * integer string on the wire. No floating-point arithmetic anywhere in this file.
 */

export const USDC_DECIMALS = 6
const SCALE = 1_000_000n
/** Largest value a Postgres BIGINT column can hold. */
export const MAX_BASE_UNITS = 9_223_372_036_854_775_807n

export class MoneyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyError'
  }
}

/** Parses a wire-format base-unit string ("49000000"). Rejects signs, decimals, exponents and overflow. */
export function parseBaseUnits(input: string): bigint {
  if (!/^\d{1,19}$/.test(input)) throw new MoneyError('Amount must be a non-negative integer string of base units')
  const value = BigInt(input)
  if (value > MAX_BASE_UNITS) throw new MoneyError('Amount is too large')
  return value
}

/** Parses a human decimal such as "49", "49.5" or "49.000001" into base units. At most 6 decimals. */
export function parseUsdc(input: string): bigint {
  const trimmed = input.trim()
  const match = /^(\d{1,13})(?:\.(\d{1,6}))?$/.exec(trimmed)
  if (!match) throw new MoneyError('Enter a USDC amount with up to 6 decimal places')
  const whole = BigInt(match[1])
  const fraction = BigInt((match[2] ?? '').padEnd(USDC_DECIMALS, '0') || '0')
  const total = whole * SCALE + fraction
  if (total > MAX_BASE_UNITS) throw new MoneyError('Amount is too large')
  return total
}

/** Formats base units as a decimal string with at least two fraction digits ("49.00", "0.000001"). */
export function formatBaseUnits(value: bigint | string): string {
  const v = typeof value === 'bigint' ? value : parseBaseUnits(value)
  const whole = v / SCALE
  const fraction = (v % SCALE).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '').padEnd(2, '0')
  return `${whole.toString()}.${fraction}`
}

export function sumBaseUnits(values: Iterable<bigint>): bigint {
  let total = 0n
  for (const v of values) total += v
  if (total > MAX_BASE_UNITS) throw new MoneyError('Total is too large')
  return total
}

/** JSON.stringify that serializes bigint as a decimal string instead of throwing. */
export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
}
