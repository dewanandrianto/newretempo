import { http, createConfig } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Beta wallet transport is pinned to the official Arc Testnet RPC only.
const arcRpcUrl = 'https://rpc.testnet.arc.io'
registerChain(arcTestnet.id, arcRpcUrl)
export const config = createConfig({
 chains: [arcTestnet],
 connectors: [injected()],
 transports: { [arcTestnet.id]: http(arcRpcUrl) },
})
