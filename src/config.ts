import { http, createConfig } from 'wagmi'
import { mainnet, arc } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// The wallet transport is independent of the configured read RPC. Verify both worlds before signing.
const arcRpcUrl = 'https://rpc.mainnet.arc.io'
registerChain(arc.id, arcRpcUrl)
export const config = createConfig({
 chains: [arc, mainnet],
 connectors: [injected()],
 transports: { [arc.id]: http(arcRpcUrl), [mainnet.id]: http('https://cloudflare-eth.com') },
})
