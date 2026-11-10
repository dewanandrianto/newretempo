import { describe, expect, it } from 'vitest'
import { assertDeployment, assertPlan, verifyWalletWorld } from '../../src/services/blockchain/guards'
import { configuration, checkout, plan } from './fixtures'
const h = configuration.genesisHash!
const rpc = ({ method }: { method: string }) => Promise.resolve(method === 'eth_chainId' ? '0x13b2' : method === 'eth_getBlockByNumber' ? { hash: h } : '0x1234')
describe('deployment and world guards', () => {
 it('rejects disabled deployment before any provider access', () => { expect(() => assertDeployment({ ...configuration, configured: false })).toThrow(/disabled/i) })
 it('requires all three world proofs', () => { expect(() => assertDeployment({ ...configuration, genesisHash: undefined })).toThrow(/proof/i) })
 it('compares wallet and reader worlds even with identical chain IDs', async () => {
   await expect(verifyWalletWorld(configuration, rpc, rpc)).resolves.toBeUndefined()
   const wrong = async (request: {method: string}) => request.method === 'eth_getBlockByNumber' ? { hash: `0x${'ff'.repeat(32)}` } : rpc(request)
   await expect(verifyWalletWorld(configuration, rpc, wrong)).rejects.toThrow(/world/i)
 })
 it('rejects wallet wrong chain or missing code', async () => {
   await expect(verifyWalletWorld(configuration, rpc, () => Promise.resolve('0x1'))).rejects.toThrow()
   await expect(verifyWalletWorld(configuration, rpc, async r => r.method === 'eth_getCode' ? '0x' : rpc(r))).rejects.toThrow()
 })
 it('rejects stale price, vesting, payout, interval and arbitrator before approval', () => {
   expect(() => assertPlan(checkout, plan)).not.toThrow()
   for (const changed of [{amount: 1n}, {interval: 1}, {vestDuration: 1}, {payout: checkout.arbitrator}, {arbitrator: checkout.merchant}, {active: false}, {trial: 1}, {customerMayRefundUnvested: false}]) expect(() => assertPlan(checkout, {...plan, ...changed})).toThrow(/plan/i)
 })
})
