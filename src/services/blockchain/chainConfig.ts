import { arcTestnet } from 'viem/chains'

// Shared internal network config for Privy and wagmi. Keep this aligned with the
// already-approved Testnet RPC; only the display name is intentionally neutral.
export const arcRpcUrl = 'https://rpc.blockdaemon.testnet.arc.io'

export const configuredArcTestnet = {
  ...arcTestnet,
  name: 'Configured network',
  rpcUrls: { ...arcTestnet.rpcUrls, default: { ...arcTestnet.rpcUrls.default, http: [arcRpcUrl] } },
}
