import { Outlet } from 'react-router-dom'
import { WagmiProvider as PrivyWagmiProvider } from '@privy-io/wagmi'
import { WagmiProvider as LegacyWagmiProvider } from 'wagmi'
import { config, legacyConfig } from '@/config'
import { useRuntimeAuthConfig } from '@/features/auth/privyRuntimeContext'

// The public landing page has no wallet consumers and does not download this route chunk.
export default function WalletRoutes() {
  const runtimeAuth = useRuntimeAuthConfig()

  if (runtimeAuth.enabled) {
    return (
      <PrivyWagmiProvider config={config}>
        <Outlet />
      </PrivyWagmiProvider>
    )
  }

  return (
    <LegacyWagmiProvider config={legacyConfig}>
      <Outlet />
    </LegacyWagmiProvider>
  )
}
