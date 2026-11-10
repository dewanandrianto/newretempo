import { isAddress, keccak256, zeroAddress } from 'viem'
import type { ChainCheckout, ChainConfiguration } from '../../../shared/chain'
import { baseUnits } from './amounts'
export type RpcRequest = (request: { method: string; params?: readonly unknown[] }) => Promise<unknown>
export function assertDeployment(c: ChainConfiguration): asserts c is ChainConfiguration & { manager: `0x${string}`; escrow: `0x${string}` } {
  if (!c.configured || c.mode === 'disabled' || !c.manager || !c.escrow) throw new Error(c.reason ?? 'Retempo deployment is disabled.')
  if (c.chainId !== 5042 || c.usdcDecimals !== 6 || c.usdc.toLowerCase() !== '0x3600000000000000000000000000000000000000') throw new Error('Unsupported Arc configuration.')
  for (const address of [c.manager, c.escrow]) if (!isAddress(address) || address === zeroAddress) throw new Error('Invalid deployment address.')
  for (const proof of [c.genesisHash, c.managerCodeHash, c.escrowCodeHash]) if (!proof || !/^0x[\da-f]{64}$/i.test(proof)) throw new Error('Deployment world proof is missing.')
  const url = new URL(c.rpcUrl)
  if (url.username || url.password || (c.mode === 'mainnet' && url.protocol !== 'https:') || (c.mode === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Unsafe configured RPC URL.')
}
export async function verifyWalletWorld(c: ChainConfiguration, reader: RpcRequest, wallet: RpcRequest): Promise<void> {
  assertDeployment(c)
  for (const rpc of [reader, wallet]) {
    const chainId = await rpc({ method: 'eth_chainId' })
    if (typeof chainId !== 'string' || BigInt(chainId) !== 5042n) throw new Error('Wrong network. Switch your wallet to Arc (5042).')
    const block = await rpc({ method: 'eth_getBlockByNumber', params: ['0x0', false] })
    if (!block || typeof block !== 'object' || !('hash' in block) || typeof block.hash !== 'string' || block.hash.toLowerCase() !== c.genesisHash!.toLowerCase()) throw new Error('Wallet RPC world mismatch. Connect to the configured Arc network, not another chain with ID 5042.')
    for (const [address, expected] of [[c.manager, c.managerCodeHash], [c.escrow, c.escrowCodeHash]]) {
      const code = await rpc({ method: 'eth_getCode', params: [address, 'latest'] })
      if (typeof code !== 'string' || !/^0x[\da-f]+$/i.test(code) || code.length <= 2 || keccak256(code as `0x${string}`).toLowerCase() !== expected!.toLowerCase()) throw new Error('Wallet RPC world mismatch: contract bytecode does not match the configured deployment.')
    }
  }
}
export interface PlanTerms { merchant: string; payout: string; arbitrator: string; amount: bigint; interval: number; trial: number; vestDuration: number; customerMayRefundUnvested: boolean; active: boolean }
export function assertPlan(c: ChainCheckout, p: PlanTerms): void {
  if (!p.active || p.amount !== baseUnits(c.amount) || p.interval !== c.intervalSeconds || p.trial !== c.trialDays * 86400 || p.vestDuration !== c.escrowDays * 86400 || p.customerMayRefundUnvested !== c.customerMayRefundUnvested || ['merchant', 'payout', 'arbitrator'].some(k => p[k as 'merchant'].toLowerCase() !== c[k as 'merchant'].toLowerCase())) throw new Error('Onchain plan differs from the displayed terms. Refresh and review before approving.')
}
