import { useCallback, useEffect, useRef, useState } from 'react'
import { useLogin, usePrivy, useWallets, type LinkedAccountWithMetadata } from '@privy-io/react-auth'
import { useSetActiveWallet } from '@privy-io/wagmi'
import { useSignMessage } from 'wagmi'
import { isAddress } from 'viem'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { useAuth } from './AuthProvider'

type Props = {
  mode: 'login' | 'link' | 'wallet'
  redirectTo?: string
  onLinked?: () => void
  onWalletReady?: () => void
}

type LoginSelection = {
  loginMethod: string | null
  loginAccount: LinkedAccountWithMetadata | null
}

type Address = `0x${string}`
const METHODS = ['email', 'google', 'twitter', 'wallet'] as const

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
    try {
      if (mode === 'wallet') {
        onWalletReady?.()
        return
      }
      const selectedAddress = selection?.loginAccount && 'address' in selection.loginAccount
        ? selection.loginAccount.address
        : undefined
      if (mode === 'login' && (selection?.loginMethod === 'wallet' || selectedAddress)) {
        const address = selectedAddress
        if (!address || !isAddress(address)) throw new Error('No wallet address was selected')
        setPendingWalletAddress(address)
        return
      }
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
        ? 'Could not link this sign-in. It may already be linked to another RETEMPO account.'
        : 'Could not verify your sign-in. Please try again.')
    } finally {
      setBusy(false)
    }
  }, [getAccessToken, linkPrivyAccount, logInWithPrivy, mode, navigate, onLinked, onWalletReady, redirectTo])

  const { login } = useLogin({
    onComplete: (selection) => { if (requested.current) void complete(selection) },
    onError: () => {
      if (!requested.current || handled.current) return
      requested.current = false
      setBusy(false)
      setError('Sign-in was cancelled or could not be completed.')
    },
  })

  const start = () => {
    void (async () => {
      if (!ready || busy || pendingWalletAddress) return
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
