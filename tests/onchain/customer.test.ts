import { expect, it } from 'vitest'
import { checkoutAvailability, assertCheckoutPreparation, checkoutDue, checkoutConsentIdentity } from '../../src/features/customer/model'
import { checkout } from './fixtures'

it('fails closed for disabled, expired, malformed, and completed capability contexts', () => {
  expect(checkoutAvailability({ ...checkout, configuration: { ...checkout.configuration, configured: false } }, 0)).toContain('disabled')
  expect(checkoutAvailability({ ...checkout, expiresAt: 'invalid' }, 0)).toContain('expired')
  expect(checkoutAvailability({ ...checkout, status: 'complete' }, 0)).toContain('verified')
  expect(checkoutAvailability(checkout, 0)).toBe(null)
})

it('does not silently use repriced prepared terms that the customer did not see', () => {
  expect(checkoutDue({ ...checkout, trialDays: 7 }, false)).toBe(0n)
  expect(checkoutDue({ ...checkout, trialDays: 7 }, true)).toBe(BigInt(checkout.amount))
  expect(() => assertCheckoutPreparation(checkout, { ...checkout, amount: '1' })).toThrow(/changed/i)
  expect(() => assertCheckoutPreparation(checkout, { ...checkout, configuration: { ...checkout.configuration, genesisHash: `0x${'aa'.repeat(32)}` } })).toThrow(/changed/i)
  expect(() => assertCheckoutPreparation(checkout, { ...checkout, paymentId: 'stable-payment' })).not.toThrow()
})

it('invalidates trial consent when the confirmed subscription requires a renewal charge', () => {
  const trial = { ...checkout, trialDays: 7 }
  const wallet = '0x3333333333333333333333333333333333333333'
  const windows = { responseWindow: 86400, resolutionTimeout: 172800 }
  const initial = checkoutConsentIdentity(trial, 'customer-a', wallet, false, windows)
  expect(checkoutDue(trial, false)).toBe(0n)
  expect(checkoutConsentIdentity(trial, 'customer-a', wallet, true, windows)).not.toBe(initial)
  expect(checkoutConsentIdentity(trial, 'customer-a', wallet, false, windows)).toBe(initial)
})

it('binds consent to customer identity, selected wallet, exact plan and reviewed payment terms', () => {
  const wallet = '0x3333333333333333333333333333333333333333'
  const windows = { responseWindow: 86400, resolutionTimeout: 172800 }
  const identity = (c = checkout, user = 'customer-a', address = wallet, w = windows) => checkoutConsentIdentity(c, user, address, false, w)
  const original = identity()
  expect(identity(checkout, 'customer-b')).not.toBe(original)
  expect(identity(checkout, 'customer-a', '0x4444444444444444444444444444444444444444')).not.toBe(original)
  for (const changed of [
    { ...checkout, id: 'other-checkout' }, { ...checkout, planName: 'Changed plan' }, { ...checkout, amount: '1' },
    { ...checkout, intervalSeconds: 86400 }, { ...checkout, trialDays: 7 }, { ...checkout, escrowDays: 14 },
    { ...checkout, customerMayRefundUnvested: !checkout.customerMayRefundUnvested },
    { ...checkout, payout: '0x5555555555555555555555555555555555555555' as const },
    { ...checkout, configuration: { ...checkout.configuration, genesisHash: `0x${'aa'.repeat(32)}` as const } },
  ]) expect(identity(changed)).not.toBe(original)
  expect(identity(checkout, 'customer-a', wallet, { ...windows, responseWindow: 1 })).not.toBe(original)
  expect(identity(checkout, 'customer-a', wallet, { ...windows, resolutionTimeout: 1 })).not.toBe(original)
  expect(identity({ ...checkout, paymentId: 'prepared-payment' })).toBe(original)
})
