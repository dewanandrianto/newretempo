import { describe, expect, it } from 'vitest'
import { invoiceTotal } from '../src/billing/money'
describe('exact invoice money', () => {
  it('multiplies and sums beyond Number precision without rounding', () => {
    expect(invoiceTotal([{ quantity: 2, unitAmount: '9007199254740993' }, { quantity: 3, unitAmount: '33333333' }])).toBe('18014398609481985')
  })
  it('rejects noncanonical, zero, numeric, negative and overflowing amounts', () => {
    for (const unitAmount of ['0', '01', '-1', '1.5', '1e3', '9223372036854775808']) expect(() => invoiceTotal([{ quantity: 1, unitAmount }])).toThrow()
    expect(() => invoiceTotal([{ quantity: 2, unitAmount: '9223372036854775807' }])).toThrow()
  })
})
