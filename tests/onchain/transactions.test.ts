import { expect, it } from 'vitest'
import { TransactionRunner, type TransactionState } from '../../src/services/blockchain/transactions'
const hash = `0x${'ab'.repeat(32)}` as const
function fixture() {
 const entries = new Map<string,string>(); let sends = 0
 const states: TransactionState[] = []
 const storage = { getItem: (k:string) => entries.get(k) ?? null, setItem: (k:string,v:string) => { entries.set(k,v) } }
 const runner = new TransactionRunner(storage, s => states.push(s))
 return { runner, storage, states, send: () => { sends++; return Promise.resolve(hash) }, sends: () => sends }
}
it('persists receipt confirmation without claiming backend success; reload retries indexing only', async () => {
 const f=fixture()
 await f.runner.run('payment', async (write,remember) => { remember({kind:'payment',recordId:'public-payment-id',states:['paid'],eventNames:['SubscriptionPaymentProcessed']}); await write('payment', f.send, () => Promise.resolve('success' as const)) })
 expect(f.runner.load('payment')?.verification?.recordId).toBe('public-payment-id')
 expect(f.runner.load('payment')?.phase).toBe('confirmed-indexing-pending')
 const reload = new TransactionRunner(f.storage)
 await reload.run('payment', async () => { await f.send() })
 expect(f.sends()).toBe(1)
 await reload.verify('payment', () => Promise.resolve(false))
 expect(reload.load('payment')?.phase).toBe('confirmed-indexing-pending')
 await reload.verify('payment', () => Promise.resolve(true))
 expect(reload.load('payment')?.phase).toBe('verified-success')
})
it('separates wallet rejection from reverted receipts', async () => {
 const f=fixture()
 await f.runner.run('reject', async write => { await write('payment', () => Promise.reject(Object.assign(new Error('User rejected'), {code:4001})), () => Promise.resolve('success' as const)) })
 expect(f.runner.load('reject')?.phase).toBe('rejected')
 await f.runner.run('revert', async write => { await write('payment', f.send, () => Promise.resolve('reverted' as const)) })
 expect(f.runner.load('revert')?.phase).toBe('reverted')
})
it('does not resubmit after receipt timeout or uncertain send', async () => {
 const f=fixture()
 await f.runner.run('timeout', async write => { await write('payment', f.send, () => Promise.reject(new Error('timeout'))) })
 expect(f.runner.load('timeout')?.phase).toBe('pending-receipt')
 await f.runner.run('timeout', async () => { await f.send() })
 expect(f.sends()).toBe(1)
 await f.runner.resume('timeout', () => Promise.resolve('success' as const))
 expect(f.runner.load('timeout')?.phase).toBe('confirmed-indexing-pending')
 await f.runner.run('unknown', async write => { await write('payment', () => Promise.reject(new Error('RPC disconnected')), () => Promise.resolve('success' as const)) })
 expect(f.runner.load('unknown')?.phase).toBe('submission-unknown')
 await f.runner.run('unknown', async () => { await f.send() })
 expect(f.sends()).toBe(1)
})
it('approval receipt is distinct and never becomes payment success', async () => {
 const f=fixture()
 await f.runner.run('approve', async write => { await write('approval', f.send, () => Promise.resolve('success' as const)); throw new Error('stale plan') })
 expect(f.runner.load('approve')?.phase).toBe('error')
 expect(f.states.some(s => s.phase==='approval-pending')).toBe(true)
 expect(f.states.some(s => s.phase==='verified-success')).toBe(false)
})
