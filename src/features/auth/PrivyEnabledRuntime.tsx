import { useCallback, type ReactNode } from 'react'
import { PrivyProvider, usePrivy } from '@privy-io/react-auth'
import { PrivyLogoutContext } from './privyRuntimeContext'

function PrivySessionBridge({ children }: { children: ReactNode }) {
  const { authenticated, logout } = usePrivy()
  const logoutForApp = useCallback(async () => {
    if (authenticated) await logout()
  }, [authenticated, logout])
  return <PrivyLogoutContext.Provider value={logoutForApp}>{children}</PrivyLogoutContext.Provider>
}

export default function PrivyEnabledRuntime({ appId, children }: { appId: string; children: ReactNode }) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email', 'google', 'twitter', 'wallet'],
        embeddedWallets: { ethereum: { createOnLogin: 'off' } },
      }}
    >
      <PrivySessionBridge>{children}</PrivySessionBridge>
    </PrivyProvider>
  )
}
