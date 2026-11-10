import { describe, expect, it, vi } from 'vitest'
// Studio tracing is browser-only; no RPC or telemetry runs in this offline test.
vi.mock('../../src/tracing', () => ({ registerChain: vi.fn() }))
import { config } from '@/config'

describe('browser wallet RPC defaults', () => {
  it('pins official Arc primary and the CORS-safe ENS mainnet transport', () => {
    const arc = config.chains.find(chain => chain.id === 5042)!
    const mainnet = config.chains.find(chain => chain.id === 1)!
    expect(config._internal.transports[arc.id]({ chain: arc }).value?.url).toBe('https://rpc.mainnet.arc.io')
    expect(config._internal.transports[mainnet.id]({ chain: mainnet }).value?.url).toBe('https://cloudflare-eth.com')
  })
})
