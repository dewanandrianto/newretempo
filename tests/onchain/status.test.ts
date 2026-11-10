import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { TransactionStatus } from '../../src/features/onchain/TransactionStatus'
it('renders confirmed-but-unverified as pending with hash and sync-only recovery',()=>{
 const html=renderToStaticMarkup(createElement(TransactionStatus,{state:{id:'op',phase:'confirmed-indexing-pending',hash:`0x${'ab'.repeat(32)}`},onSync:()=>{},onResume:()=>{}}))
 expect(html).toContain('Confirmed onchain');expect(html).toContain('Retry verification');expect(html).not.toContain('Payment successful');expect(html).toContain('0xabab')
})
