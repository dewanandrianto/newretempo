import { Outlet } from 'react-router-dom'
import { WagmiProvider } from 'wagmi'
import { ConnectKitProvider } from 'connectkit'
import { config } from '@/config'

// This stable layout preserves the real wallet context across all application routes.
// The public landing page has no wallet consumers and does not download the wallet SDK.
export default function WalletRoutes() {
  return (
    <WagmiProvider config={config}>
      <ConnectKitProvider>
        <Outlet />
      </ConnectKitProvider>
    </WagmiProvider>
  )
}
