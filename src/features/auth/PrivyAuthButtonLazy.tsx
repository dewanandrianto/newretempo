import { lazy, Suspense } from 'react'

const PrivyAuthButton = lazy(() => import('./PrivyAuthButton').then((module) => ({ default: module.PrivyAuthButton })))

type Props = {
  mode: 'login' | 'link'
  redirectTo?: string
  onLinked?: () => void
}

export function PrivyAuthButtonLazy(props: Props) {
  return (
    <Suspense fallback={<p role="status" className="text-center text-sm text-dim">Loading sign-in options…</p>}>
      <PrivyAuthButton {...props} />
    </Suspense>
  )
}
