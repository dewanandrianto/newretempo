import { formatUnits, parseUnits } from 'viem'
const UINT128_MAX = (1n << 128n) - 1n
export function baseUnits(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('Amount must be a canonical base-unit integer.')
  const amount = BigInt(value)
  if (amount > UINT128_MAX) throw new Error('Amount exceeds the contract limit.')
  return amount
}
export function parseUsdc(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) throw new Error('Enter an exact USDC amount with at most six decimals.')
  return baseUnits(parseUnits(value, 6).toString())
}
export function displayUsdc(value: string | bigint): string {
  return formatUnits(baseUnits(value.toString()), 6)
}
