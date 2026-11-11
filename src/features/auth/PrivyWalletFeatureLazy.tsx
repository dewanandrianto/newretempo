import { lazy, Suspense } from 'react'

const EmbeddedWalletAddress = lazy(() => import('./PrivyWalletFeature').then((module) => ({ default: module.EmbeddedWalletAddress })))
const EmbeddedWalletSettings = lazy(() => import('./PrivyWalletFeature').then((module) => ({ default: module.EmbeddedWalletSettings })))

export function EmbeddedWalletAddressLazy({
  value,
  generation,
  onAddress,
  onVerifyAvailable,
}: {
  value: string
  generation: number
  onAddress: (address: string, pairKey: string, generation: number) => void
  onVerifyAvailable: (verify: (() => Promise<boolean>) | null) => void
}) {
  return (
    <Suspense fallback={<p role="status" className="text-xs text-faint">Loading wallet details…</p>}>
      <EmbeddedWalletAddress value={value} generation={generation} onAddress={onAddress} onVerifyAvailable={onVerifyAvailable} />
    </Suspense>
  )
}

export function EmbeddedWalletSettingsLazy() {
  return (
    <Suspense fallback={<p role="status" className="text-sm text-dim">Loading wallet settings…</p>}>
      <EmbeddedWalletSettings />
    </Suspense>
  )
}
