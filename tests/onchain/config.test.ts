import { describe, expect, it, vi } from 'vitest'
// Studio tracing is browser-only; no RPC or telemetry runs in this offline test.
vi.mock('../../src/tracing', () => ({ registerChain: vi.fn() }))
import { config } from '@/config'

describe('browser wallet RPC defaults', () => {
  it('pins the approved Arc Testnet chain and RPC transport', () => {
    expect(config.chains).toHaveLength(1)
    const arcTestnet = config.chains.find(chain => chain.id === 5042002)!
    expect(arcTestnet).toBeDefined()
    expect(config._internal.transports[arcTestnet.id]({ chain: arcTestnet }).value?.url).toBe('https://rpc.blockdaemon.testnet.arc.io')
  })
})
