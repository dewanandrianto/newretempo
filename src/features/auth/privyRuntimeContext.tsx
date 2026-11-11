import { createContext, useContext } from 'react'

export interface RuntimeAuthConfig {
  enabled: boolean
  appId: string | null
}

export const disabledAuthConfig: RuntimeAuthConfig = { enabled: false, appId: null }
export const RuntimeAuthContext = createContext<RuntimeAuthConfig>(disabledAuthConfig)
export const PrivyLogoutContext = createContext<() => Promise<void>>(() => Promise.resolve())

export function useRuntimeAuthConfig() {
  return useContext(RuntimeAuthContext)
}

export function usePrivyLogout() {
  return useContext(PrivyLogoutContext)
}
