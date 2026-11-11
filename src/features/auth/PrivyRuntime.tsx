import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { disabledAuthConfig, RuntimeAuthContext, type RuntimeAuthConfig } from './privyRuntimeContext'

const PrivyEnabledRuntime = lazy(() => import('./PrivyEnabledRuntime'))

export function PrivyRuntime({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<RuntimeAuthConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetch('/api/auth/config', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error('Auth config unavailable')
        const value = (await response.json()) as Partial<RuntimeAuthConfig>
        if (typeof value.enabled !== 'boolean' || (value.enabled && typeof value.appId !== 'string')) throw new Error('Invalid auth config')
        return { enabled: value.enabled, appId: value.enabled ? value.appId! : null }
      })
      .catch(() => disabledAuthConfig)
      .then((value) => { if (!cancelled) setConfig(value) })
    return () => { cancelled = true }
  }, [])

  if (!config) {
    return <div className="grid min-h-dvh place-items-center bg-midnight text-sm text-dim" role="status">Loading RETEMPO…</div>
  }

  const app = config.enabled && config.appId ? (
    <Suspense fallback={<div className="grid min-h-dvh place-items-center bg-midnight text-sm text-dim" role="status">Loading sign-in…</div>}>
      <PrivyEnabledRuntime appId={config.appId}>{children}</PrivyEnabledRuntime>
    </Suspense>
  ) : children

  return <RuntimeAuthContext.Provider value={config}>{app}</RuntimeAuthContext.Provider>
}
