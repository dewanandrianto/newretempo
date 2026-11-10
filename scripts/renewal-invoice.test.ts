import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toSubscription } from '../src/services/billing/mappers'
import type { ApiSubscription } from '../shared/types'
import { invoiceDraftInput, matchingSubscriptions } from '../src/features/dashboard/forms/invoiceDraft'

const api: ApiSubscription = {
 id:'sub',customerId:'customer',customerName:'Buyer',planId:'plan',planName:'Exact plan',
 status:'active',amount:'999999999999999',interval:'month',currentPeriodStart:null,
 currentPeriodEnd:'2026-12-01T13:14:15.123Z',cancelAtPeriodEnd:false,createdAt:'2026-11-01T13:14:15.123Z',
}
void test('subscription mapping preserves the full verified next-charge UTC timestamp for period identity',()=>{
 assert.equal(toSubscription(api).currentPeriodEnd,api.currentPeriodEnd)
 assert.equal(toSubscription({...api,currentPeriodEnd:null}).currentPeriodEnd,'')
})
const fields = {customerId:'customer',subscriptionId:'sub',description:'Next period',quantity:'8',price:'1.00',dueDate:'2026-12-14',memo:''}
void test('subscription invoice fixes quantity and exact price and submits the full next-period identity',()=>{
 const body=invoiceDraftInput(fields,[toSubscription(api)])
 assert.equal(body.subscriptionId,'sub')
 assert.equal(body.periodStart,api.currentPeriodEnd)
 assert.deepEqual(body.lineItems,[{description:'Next period',quantity:1,unitAmount:'999999999999999'}])
})
void test('changing customer cannot silently attach another customer subscription or fall back to standalone',()=>{
 assert.throws(()=>invoiceDraftInput({...fields,customerId:'other'},[toSubscription(api)]),/matching customer/)
 assert.throws(()=>invoiceDraftInput({...fields,subscriptionId:'missing'},[toSubscription(api)]),/matching customer/)
})
void test('renewal rejects canceled subscriptions and missing or day-truncated period timestamps',()=>{
 const subscription=toSubscription(api)
 for(const currentPeriodEnd of ['', '2026-12-01','2026-02-30T13:14:15.123Z']) {
  assert.throws(()=>invoiceDraftInput(fields,[{...subscription,currentPeriodEnd}]),/full UTC/)
 }
 assert.throws(()=>invoiceDraftInput(fields,[{...subscription,status:'canceled'}]),/canceled/)
})
void test('subscription selector only offers the chosen customer non-canceled subscriptions',()=>{
 const matching=toSubscription(api)
 assert.deepEqual(matchingSubscriptions([matching,{...matching,id:'foreign',customerId:'other'},{...matching,id:'canceled',status:'canceled'}],'customer'),[matching])
})
void test('standalone invoices keep exact editable amounts and reject zero prices',()=>{
 const standalone={...fields,subscriptionId:'',price:'9007199254.740993',quantity:'2'}
 const body=invoiceDraftInput(standalone,[])
 assert.equal(body.subscriptionId,undefined)
 assert.equal(body.periodStart,undefined)
 assert.deepEqual(body.lineItems,[{description:fields.description,quantity:2,unitAmount:'9007199254740993'}])
 assert.throws(()=>invoiceDraftInput({...standalone,price:'0'},[]),/greater than zero/)
})
