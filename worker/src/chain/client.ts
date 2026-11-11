import type { ChainAddress, ChainBinding, ChainConfiguration, ChainSnapshot, ChainSyncResult } from '../../../shared/chain'
import type { WorkerBindings } from '../types'
import { unavailable } from '../errors'
type PauseConfiguration = { managerPaused?: boolean | null; escrowPaused?: boolean | null }
type PausableChainConfiguration = ChainConfiguration & PauseConfiguration
export const disabledConfiguration: PausableChainConfiguration = { chainId: 5042002, mode: 'disabled', configured: false, rpcUrl: 'https://rpc.blockdaemon.testnet.arc.io', explorerUrl: 'https://explorer.testnet.arc.io', usdc: '0x3600000000000000000000000000000000000000', usdcDecimals: 6, manager: null, escrow: null, managerPaused: null, escrowPaused: null, startBlock: null, reason: 'Testnet contract service is not configured; payments and settlement are disabled' }
export async function privateRequest<T>(env: WorkerBindings, path: string, body?: unknown): Promise<T> {
  if (!env.CHAIN) throw unavailable('Chain service is not configured', 'chain_unavailable')
  let response: Response
  try { response = await env.CHAIN.fetch(new Request(`https://private-chain${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })) }
  catch { throw unavailable('Chain service is unavailable', 'chain_unavailable') }
  if (!response.ok) throw unavailable('Chain service rejected the operation', 'chain_unavailable')
  return response.json<T>()
}
export async function configuration(env: WorkerBindings): Promise<ChainConfiguration> { return env.CHAIN ? privateRequest(env, '/v1/config') : disabledConfiguration }
/** Configured validation for read-only chain operations; pause state never blocks reads or sync. */
export async function configuredConfiguration(env: WorkerBindings) {
  const config = await configuration(env)
  if (!config.configured || !config.manager || !config.escrow) throw unavailable('Contract deployment is not configured', 'chain_unavailable')
  return config
}
/** Financial preparation is allowed only when both contracts are explicitly unpaused. */
export async function enabledConfiguration(env: WorkerBindings) {
  const config = await configuredConfiguration(env) as PausableChainConfiguration
  if (config.managerPaused !== false || config.escrowPaused !== false) throw unavailable('Contract deployment is paused or pause state is unavailable', 'chain_unavailable')
  return config
}
export async function snapshot(env: WorkerBindings, orgId: string, pageToken?: string): Promise<ChainSnapshot> {
  if (!env.CHAIN) return { configuration: disabledConfiguration, cursor: null, bindings: [], events: [], projections: [] }
  const result = await privateRequest<ChainSnapshot>(env, '/v1/snapshot', { orgId, ...(pageToken ? { pageToken } : {}) })
  if (!result.configuration.configured || !result.configuration.manager || !result.configuration.escrow) throw unavailable('Contract deployment is not configured', 'chain_unavailable')
  if (result.bindings.some(b => b.orgId !== orgId) || result.projections.some(p => p.orgId !== orgId)) throw unavailable('Chain snapshot tenant mismatch', 'chain_unavailable')
  return result
}
export const bind = (env: WorkerBindings, binding: ChainBinding) => privateRequest<ChainBinding>(env, '/v1/bind', binding)
/** Wallet-wide proofs belong to the verified account owner, never to organization totals. */
export async function walletSnapshot(env: WorkerBindings, wallet: ChainAddress, pageToken?: string): Promise<ChainSnapshot> {
  const result = await privateRequest<ChainSnapshot>(env, '/v1/wallet-snapshot', { wallet, ...(pageToken ? { pageToken } : {}) })
  if (!result.configuration.configured || !result.configuration.manager || !result.configuration.escrow) throw unavailable('Contract deployment is not configured', 'chain_unavailable')
  if (result.bindings.length !== 0 || result.projections.some(p => p.kind !== 'wallet' || p.orgId !== `wallet:${wallet}` || p.recordId !== wallet || p.values.account !== wallet) || result.events.some(event => !['Withdrawn', 'PayoutAddressUpdated'].includes(event.name) || event.args.account !== wallet)) {
    throw unavailable('Chain wallet snapshot ownership mismatch', 'chain_unavailable')
  }
  return result
}
export const sync = (env: WorkerBindings) => privateRequest<ChainSyncResult>(env, '/v1/sync', {})
