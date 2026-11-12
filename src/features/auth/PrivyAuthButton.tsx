import { useCallback, useEffect, useRef, useState } from 'react'
import { useLogin, usePrivy, useWallets, type LinkedAccountWithMetadata } from '@privy-io/react-auth'
import { useSetActiveWallet } from '@privy-io/wagmi'
import { useSignMessage } from 'wagmi'
import { isAddress } from 'viem'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '@/services/api/client'
import { Button } from '@/components/ui/Button'
import { useAuth } from './AuthProvider'
import { canFinalizePrivyCompletion, getAuthenticatedPrivyAccessToken, PrivyAccessTokenError } from './privyAccessToken'

type Props = {
  mode: 'login' | 'link' | 'wallet'
  redirectTo?: string
  onLinked?: () => void
  onWalletReady?: () => void
}

type LoginSelection = {
  loginMethod: string | null
  selectedAddress?: string
}

type Address = `0x${string}`
const METHODS = ['email', 'google', 'twitter', 'wallet'] as const

function selectionForCompletion(selection: { loginMethod: string | null; loginAccount: LinkedAccountWithMetadata | null }): LoginSelection {
  const account = selection.loginAccount
  const selectedAddress = account && 'address' in account && typeof account.address === 'string'
    ? account.address
    : undefined
  return { loginMethod: selection.loginMethod, selectedAddress }
}

// Temporary sign-in diagnostics expose only an allowlisted code, never raw errors or tokens.
const SAFE_PRIVY_ERROR_CODES = new Set([
  'privy_not_enabled', 'privy_not_configured', 'configuration_error',
  'token_missing', 'token_malformed', 'jwt_invalid', 'jwks_fetch_failed',
  'identity_mapping_failed', 'session_write_failed', 'account_response_failed',
  'privy_request_gate', 'rate_limited', 'unauthorized', 'forbidden',
  'not_found', 'conflict', 'network_error', 'internal_error',
  'privy_not_ready', 'privy_not_authenticated', 'privy_auth_state_timeout',
  'wallet_selection_invalid', 'login_completion_failed',
])

function safeDiagnosticCode(error: unknown, fallback: string): string {
  if (error instanceof PrivyAccessTokenError) return error.code
  if (!(error instanceof ApiError)) return fallback
  if (SAFE_PRIVY_ERROR_CODES.has(error.code)) return error.code
  return Number.isInteger(error.status) && error.status >= 0 && error.status <= 599
    ? `server_http_${error.status}`
    : 'server_error'
}

export function PrivyAuthButton({ mode, redirectTo, onLinked, onWalletReady }: Props) {
  const { ready, authenticated, getAccessToken, logout } = usePrivy()
  const { wallets } = useWallets()
  const { setActiveWallet } = useSetActiveWallet()
  const { signMessageAsync } = useSignMessage()
  const { logInWithPrivy, linkPrivyAccount, requestWalletChallenge, verifyWalletSignature } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [switchRequired, setSwitchRequired] = useState(false)
  const [pendingWalletAddress, setPendingWalletAddress] = useState<Address>()
  const [completionPending, setCompletionPending] = useState(false)
  const completionSelection = useRef<LoginSelection | undefined>(undefined)
  const requested = useRef(false)
  const handled = useRef(false)
  const signingWallet = useRef(false)

  const signInWithWallet = useCallback(async (address: Address) => {
    setBusy(true)
    setError(undefined)
    try {
      const { message } = await requestWalletChallenge(address)
      const signature = await signMessageAsync({ message, account: address })
      const session = await verifyWalletSignature({ message, signature })
      await navigate(session.organization ? (redirectTo ?? '/app') : '/onboarding', { replace: true })
    } catch {
      setError('Wallet sign-in was cancelled or could not be verified. Please try again.')
      setPendingWalletAddress(undefined)
    } finally {
      setBusy(false)
      signingWallet.current = false
    }
  }, [navigate, redirectTo, requestWalletChallenge, signMessageAsync, verifyWalletSignature])

  useEffect(() => {
    if (!pendingWalletAddress || signingWallet.current) return
    const wallet = wallets.find((item) => item.type === 'ethereum' && item.address.toLowerCase() === pendingWalletAddress.toLowerCase())
    if (!wallet) return
    signingWallet.current = true
    void setActiveWallet(wallet)
      .then(() => signInWithWallet(pendingWalletAddress))
      .catch(() => {
        setError('The selected wallet could not be prepared. Please try again.')
        setPendingWalletAddress(undefined)
        signingWallet.current = false
      })
  }, [pendingWalletAddress, setActiveWallet, signInWithWallet, wallets])

  useEffect(() => {
    if (!pendingWalletAddress) return
    const timer = window.setTimeout(() => {
      if (signingWallet.current) return
      setError('The selected wallet did not become ready. Please try again.')
      setPendingWalletAddress(undefined)
    }, 15000)
    return () => window.clearTimeout(timer)
  }, [pendingWalletAddress])

  const complete = useCallback(async (selection?: LoginSelection) => {
    if (!requested.current || handled.current) return
    handled.current = true
    setBusy(true)
    setError(undefined)
    let fallbackDiagnostic = 'login_completion_failed'
    try {
      if (mode === 'wallet') {
        onWalletReady?.()
        return
      }
      const selectedAddress = selection?.selectedAddress
      if (mode === 'login' && (selection?.loginMethod === 'wallet' || selectedAddress)) {
        const address = selectedAddress
        if (!address || !isAddress(address)) {
          fallbackDiagnostic = 'wallet_selection_invalid'
          throw new Error('No wallet address was selected')
        }
        setPendingWalletAddress(address)
        return
      }
      fallbackDiagnostic = 'token_fetch_failed'
      const accessToken = await getAuthenticatedPrivyAccessToken({ ready, authenticated, getAccessToken })
      fallbackDiagnostic = mode === 'login' ? 'client_session_failed' : 'client_link_failed'
      if (mode === 'login') {
        const session = await logInWithPrivy(accessToken)
        fallbackDiagnostic = 'client_navigation_failed'
        await navigate(session.organization ? (redirectTo ?? '/app') : '/onboarding', { replace: true })
      } else {
        await linkPrivyAccount(accessToken)
        onLinked?.()
      }
    } catch (error) {
      handled.current = false
      requested.current = false
      completionSelection.current = undefined
      setCompletionPending(false)
      setSwitchRequired(mode === 'link')
      const code = safeDiagnosticCode(error, fallbackDiagnostic)
      setError(mode === 'link'
        ? `Could not link this sign-in. It may already be linked to another RETEMPO account. [${code}]`
        : `Could not verify your sign-in. Please try again. [${code}]`)
    } finally {
      setBusy(false)
    }
  }, [authenticated, getAccessToken, linkPrivyAccount, logInWithPrivy, mode, navigate, onLinked, onWalletReady, ready, redirectTo])

  useEffect(() => {
    if (!completionPending || !requested.current || !canFinalizePrivyCompletion({ ready, authenticated, mode })) return
    const selection = completionSelection.current
    completionSelection.current = undefined
    setCompletionPending(false)
    void complete(selection)
  }, [authenticated, complete, completionPending, mode, ready])

  useEffect(() => {
    if (!completionPending) return
    const timer = window.setTimeout(() => {
      if (!requested.current || handled.current) return
      completionSelection.current = undefined
      setCompletionPending(false)
      requested.current = false
      handled.current = false
      setBusy(false)
      setError(mode === 'link'
        ? 'Could not confirm the Privy sign-in state. Please try again. [privy_auth_state_timeout]'
        : 'Could not verify your sign-in. Please try again. [privy_auth_state_timeout]')
    }, 15_000)
    return () => window.clearTimeout(timer)
  }, [completionPending, mode])

  const { login } = useLogin({
    onComplete: (selection) => {
      if (!requested.current) return
      completionSelection.current = selectionForCompletion(selection)
      setCompletionPending(true)
    },
    onError: () => {
      if (!requested.current || handled.current) return
      requested.current = false
      completionSelection.current = undefined
      setCompletionPending(false)
      setBusy(false)
      setError('Sign-in was cancelled or could not be completed.')
    },
  })

  const start = () => {
    void (async () => {
      if (!ready || busy || pendingWalletAddress) return
      completionSelection.current = undefined
      setCompletionPending(false)
      requested.current = true
      handled.current = false
      setError(undefined)
      if (mode === 'login' && authenticated) {
        setBusy(true)
        try {
          await logout()
        } catch {
          requested.current = false
          setBusy(false)
          setError('Could not switch sign-in methods. Please try again.')
          return
        }
      } else if (authenticated && !(mode === 'link' && switchRequired)) {
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
          setError('Could not switch the sign-in. Please try again.')
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
      <Button type="button" size="lg" className="w-full" loading={!ready || busy || Boolean(pendingWalletAddress)} onClick={start}>
        {mode === 'link'
          ? switchRequired ? 'Switch sign-in and retry' : 'Verify sign-in and link'
          : 'Continue with RETEMPO'}
      </Button>
      {error && <p role="alert" className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">{error}</p>}
    </div>
  )
}
