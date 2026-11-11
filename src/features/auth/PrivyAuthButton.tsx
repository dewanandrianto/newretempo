import { useCallback, useRef, useState } from 'react'
import { useLogin, usePrivy } from '@privy-io/react-auth'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { useAuth } from './AuthProvider'

type Props = {
  mode: 'login' | 'link'
  redirectTo?: string
  onLinked?: () => void
}

const METHODS = ['email', 'google', 'twitter', 'wallet'] as const

export function PrivyAuthButton({ mode, redirectTo, onLinked }: Props) {
  const { ready, authenticated, getAccessToken, logout } = usePrivy()
  const { logInWithPrivy, linkPrivyAccount } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [switchRequired, setSwitchRequired] = useState(false)
  const requested = useRef(false)
  const handled = useRef(false)

  const complete = useCallback(async () => {
    if (!requested.current || handled.current) return
    handled.current = true
    setBusy(true)
    setError(undefined)
    try {
      const accessToken = await getAccessToken()
      if (!accessToken) throw new Error('Missing Privy access token')
      if (mode === 'login') {
        const session = await logInWithPrivy(accessToken)
        await navigate(session.organization ? (redirectTo ?? '/app') : '/onboarding', { replace: true })
      } else {
        await linkPrivyAccount(accessToken)
        onLinked?.()
      }
    } catch {
      handled.current = false
      requested.current = false
      setSwitchRequired(mode === 'link')
      setError(mode === 'link'
        ? 'Could not link this Privy sign-in. It may already be linked to another RETEMPO account.'
        : 'Could not verify your Privy sign-in. Please try again.')
    } finally {
      setBusy(false)
    }
  }, [getAccessToken, linkPrivyAccount, logInWithPrivy, mode, navigate, onLinked, redirectTo])

  const { login } = useLogin({
    onComplete: () => { if (requested.current) void complete() },
    onError: () => {
      if (!requested.current || handled.current) return
      requested.current = false
      setBusy(false)
      setError('Sign-in was cancelled or could not be completed.')
    },
  })

  const start = () => {
    void (async () => {
      if (!ready || busy) return
      requested.current = true
      handled.current = false
      setError(undefined)
      if (authenticated && !(mode === 'link' && switchRequired)) {
        void complete()
        return
      }
      if (authenticated && mode === 'link' && switchRequired) {
        setBusy(true)
        try {
          await logout()
        } catch {
          requested.current = false
          setBusy(false)
          setError('Could not switch the Privy sign-in. Please try again.')
          return
        }
      }
      setSwitchRequired(false)
      setBusy(true)
      login({ loginMethods: [...METHODS], walletChainType: 'ethereum-only' })
    })()
  }

  return (
    <div className="space-y-2">
      <Button type="button" size="lg" className="w-full" loading={!ready || busy} onClick={start}>
        {mode === 'login'
          ? 'Continue with email, Google, X, or wallet'
          : switchRequired ? 'Switch Privy account and retry' : 'Verify Privy sign-in and link'}
      </Button>
      {error && <p role="alert" className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">{error}</p>}
    </div>
  )
}
