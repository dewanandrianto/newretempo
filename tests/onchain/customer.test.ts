import { expect, it } from 'vitest'
import { checkoutAvailability, assertCheckoutPreparation, checkoutDue } from '../../src/features/customer/model'
import { checkout } from './fixtures'
it('fails closed for disabled, expired, malformed, and completed capability contexts',()=>{
 expect(checkoutAvailability({...checkout,configuration:{...checkout.configuration,configured:false}},0)).toContain('disabled')
 expect(checkoutAvailability({...checkout,expiresAt:'invalid'},0)).toContain('expired')
 expect(checkoutAvailability({...checkout,status:'complete'},0)).toContain('verified')
 expect(checkoutAvailability(checkout,0)).toBe(null)
})
it('does not silently use repriced prepared terms that the customer did not see',()=>{
 expect(checkoutDue({...checkout,trialDays:7},false)).toBe(0n)
 expect(checkoutDue({...checkout,trialDays:7},true)).toBe(BigInt(checkout.amount))
 expect(()=>assertCheckoutPreparation(checkout,{...checkout,amount:'1'})).toThrow(/changed/i)
 expect(()=>assertCheckoutPreparation(checkout,{...checkout,configuration:{...checkout.configuration,genesisHash:`0x${'aa'.repeat(32)}`}})).toThrow(/changed/i)
 expect(()=>assertCheckoutPreparation(checkout,{...checkout,paymentId:'stable-payment'})).not.toThrow()
})
