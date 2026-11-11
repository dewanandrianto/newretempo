import { http, createConfig } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Use the official Arc-listed Testnet RPC that passed the read-only preflight.
const arcRpcUrl = 'https://rpc.blockdaemon.testnet.arc.io'
const configuredArcTestnet = {
  ...arcTestnet,
  rpcUrls: { ...arcTestnet.rpcUrls, default: { ...arcTestnet.rpcUrls.default, http: [arcRpcUrl] } },
}
registerChain(arcTestnet.id, arcRpcUrl)
export const config = createConfig({
 chains: [configuredArcTestnet],
 connectors: [injected()],
 transports: { [arcTestnet.id]: http(arcRpcUrl) },
})
