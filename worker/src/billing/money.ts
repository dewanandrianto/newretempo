import { z } from 'zod'
import { validationFailed } from '../errors'

export const MAX_AMOUNT = 9223372036854775807n
export const positiveAmount = z.string().regex(/^[1-9][0-9]*$/, 'Use a positive canonical integer string').refine(v => /^[1-9][0-9]*$/.test(v) && v.length <= 19 && BigInt(v) <= MAX_AMOUNT, 'Amount is too large')
export function invoiceTotal(items: readonly { quantity: number; unitAmount: string }[]): string {
  let total = 0n
  for (const item of items) {
    if (!positiveAmount.safeParse(item.unitAmount).success || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000) throw validationFailed({ lineItems: 'Invalid line item amount or quantity' })
    total += BigInt(item.quantity) * BigInt(item.unitAmount)
    if (total > MAX_AMOUNT) throw validationFailed({ lineItems: 'Invoice total is too large' })
  }
  if (total <= 0n) throw validationFailed({ lineItems: 'Add at least one line item' })
  return total.toString()
}
