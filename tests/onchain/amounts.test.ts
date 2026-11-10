import { describe, expect, it } from 'vitest'
import { baseUnits, displayUsdc, parseUsdc } from '../../src/services/blockchain/amounts'
describe('exact six-decimal USDC', () => {
  it('roundtrips values above safe integer without rounding', () => {
    expect(parseUsdc('9007199254740993.123456')).toBe(9007199254740993123456n)
    expect(displayUsdc('9007199254740993123456')).toBe('9007199254740993.123456')
  })
  it('rejects noncanonical wire integers and precision loss', () => {
    for (const value of ['01', '-1', '1.1', '1e6', '']) expect(() => baseUnits(value)).toThrow()
    expect(() => parseUsdc('0.0000001')).toThrow()
  })
})
