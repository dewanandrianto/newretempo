import type { Subscription } from '@shared/types'
import type { InvoiceInput } from '@/services/merchant/api'
import { parseUsdc } from '@shared/money'

interface DraftFields {
 customerId: string
 subscriptionId: string
 description: string
 quantity: string
 price: string
 dueDate: string
 memo: string
}

export function matchingSubscriptions(subscriptions: readonly Subscription[], customerId: string): Subscription[] {
 return subscriptions.filter(s=>s.customerId===customerId&&s.status!=='canceled')
}

/** Subscription amounts and period identity come from the read model, never editable price fields. */
export function invoiceDraftInput(fields: DraftFields, subscriptions: readonly Subscription[]): InvoiceInput {
 const subscription=fields.subscriptionId?subscriptions.find(s=>s.id===fields.subscriptionId):undefined
 if(fields.subscriptionId&&(!subscription||subscription.customerId!==fields.customerId))throw new Error('Select a subscription for the matching customer.')
 if(subscription){
  if(subscription.status==='canceled')throw new Error('A canceled subscription cannot be renewed.')
  const period=subscription.currentPeriodEnd
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(period)||!Number.isFinite(Date.parse(period))||new Date(period).toISOString()!==period)throw new Error('A full UTC next billing period is required. Refresh the subscription; use its initial checkout if it has not started.')
 }
 const amount=parseUsdc(subscription?.amount??fields.price)
 if(amount<=0n)throw new Error('Enter an amount greater than zero.')
 return {
  customerId:fields.customerId,
  ...(subscription?{subscriptionId:subscription.id,periodStart:subscription.currentPeriodEnd}:{}),
  lineItems:[{description:fields.description,quantity:subscription?1:Number(fields.quantity),unitAmount:amount.toString()}],
  dueAt:new Date(`${fields.dueDate}T23:59:59Z`).toISOString(),
  memo:fields.memo,
 }
}
