import { lazy, Suspense } from 'react'

const PrivyCustomerWalletPicker = lazy(() => import('./PrivyCustomerWalletPicker').then((module) => ({ default: module.PrivyCustomerWalletPicker })))

export function PrivyCustomerWalletPickerLazy() {
  return <Suspense fallback={<p role="status" className="text-sm text-dim">Loading wallet options…</p>}><PrivyCustomerWalletPicker /></Suspense>
}
