import { createConfig as createPrivyConfig } from '@privy-io/wagmi'
import { createConfig as createLegacyConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { arcRpcUrl, configuredArcTestnet } from '@/services/blockchain/chainConfig'
import { registerChain } from './tracing'

registerChain(configuredArcTestnet.id, arcRpcUrl)

// Privy manages the connected wallet; wagmi supplies the application's chain hooks.
export const config = createPrivyConfig({
  chains: [configuredArcTestnet],
  transports: { [configuredArcTestnet.id]: http(arcRpcUrl) },
})

// Preserve the old SIWE recovery connector only if the server-side Privy flag is off.
const legacyConnectors = [injected()]
export const legacyConfig = createLegacyConfig({
  chains: [configuredArcTestnet],
  connectors: legacyConnectors,
  transports: { [configuredArcTestnet.id]: http(arcRpcUrl) },
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
