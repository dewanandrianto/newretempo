import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useCreateWallet, useExportWallet, usePrivy, useWallets } from '@privy-io/react-auth'
import { Copy, KeyRound, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { useAuth } from './AuthProvider'
import { startOrJoinVersionedRequest, type VersionedRequest } from './PrivyAccessRequest'

type Address = `0x${string}`
type AccessSnapshot = { key: string; allowed: boolean }
type AccessState = 'checking' | 'allowed' | 'denied'

function embeddedEvmWallet(wallets: ReturnType<typeof useWallets>['wallets']) {
  return wallets.find((wallet) =>
    wallet.type === 'ethereum' && (wallet.walletClientType === 'privy' || wallet.walletClientType === 'privy-v2'),
  )
}

/** Every wallet action is bound to the active server session and the same signed Privy DID. */
function useCurrentWalletAccess() {
  const { status: sessionStatus, session, verifyPrivyWalletAccess } = useAuth()
  const { authenticated, ready: privyReady, user, getAccessToken } = usePrivy()
  const accountId = session?.user.id ?? ''
  const identityId = user?.id ?? ''
  const key = `${accountId}\u0000${identityId}`
  const currentKeyRef = useRef(key)
  const requestVersionRef = useRef(0)
  const accessRequestsRef = useRef(new Map<string, VersionedRequest<boolean>>())
  const mountedRef = useRef(true)
  const [snapshot, setSnapshot] = useState<AccessSnapshot | null>(null)
  const [actionCheck, setActionCheck] = useState<{ key: string; checking: boolean } | null>(null)

  useLayoutEffect(() => {
    currentKeyRef.current = key
  }, [key])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestVersionRef.current += 1
    }
  }, [])

  const performCheck = useCallback(() => {
    const requestKey = key
    if (sessionStatus !== 'ready' || !privyReady || !authenticated || !accountId || !identityId) return Promise.resolve(false)
    return startOrJoinVersionedRequest(accessRequestsRef.current, requestVersionRef, requestKey, async (requestVersion) => {
      try {
        if (requestVersionRef.current !== requestVersion) return false
        const accessToken = await getAccessToken()
        if (!accessToken) throw new Error('Missing sign-in token')
        const result = await verifyPrivyWalletAccess(accessToken)
        const stillCurrent = mountedRef.current && currentKeyRef.current === requestKey && requestVersionRef.current === requestVersion
        if (stillCurrent) setSnapshot({ key: requestKey, allowed: result.allowed })
        return stillCurrent && result.allowed
      } catch {
        if (mountedRef.current && currentKeyRef.current === requestKey && requestVersionRef.current === requestVersion) {
          setSnapshot({ key: requestKey, allowed: false })
        }
        return false
      }
    })
  }, [accountId, authenticated, getAccessToken, identityId, key, privyReady, sessionStatus, verifyPrivyWalletAccess])

  const verify = useCallback(async () => {
    const requestKey = key
    if (sessionStatus !== 'ready' || !privyReady || !authenticated || !accountId || !identityId) return false
    setActionCheck({ key: requestKey, checking: true })
    try {
      return await performCheck()
    } finally {
      if (mountedRef.current && currentKeyRef.current === requestKey) {
        setActionCheck({ key: requestKey, checking: false })
      }
    }
  }, [accountId, authenticated, identityId, key, performCheck, privyReady, sessionStatus])

  useEffect(() => {
    if (sessionStatus === 'loading' || !privyReady || !authenticated || !accountId || !identityId) return
    void performCheck()
  }, [accountId, authenticated, identityId, key, performCheck, privyReady, sessionStatus])

  useEffect(() => {
    const recheckWhenVisible = () => {
      if (document.visibilityState === 'visible') void verify()
    }
    document.addEventListener('visibilitychange', recheckWhenVisible)
    window.addEventListener('focus', recheckWhenVisible)
    return () => {
      document.removeEventListener('visibilitychange', recheckWhenVisible)
      window.removeEventListener('focus', recheckWhenVisible)
    }
  }, [verify])

  const matchesCurrentPair = snapshot?.key === key
  const actionPending = actionCheck?.key === key && actionCheck.checking
  const state: AccessState = sessionStatus === 'loading' || !privyReady ||
    (authenticated && Boolean(accountId && identityId) && !matchesCurrentPair) ||
    actionPending
    ? 'checking'
    : matchesCurrentPair && snapshot?.allowed ? 'allowed' : 'denied'

  return { state, verify, authenticated, hasRetempoSession: Boolean(session), key }
}

export function EmbeddedWalletAddress({
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
  const { wallets, ready } = useWallets()
  const wallet = embeddedEvmWallet(wallets)
  const access = useCurrentWalletAccess()
  const lastSuggested = useRef<string | null>(null)

  useEffect(() => {
    onVerifyAvailable(access.verify)
    return () => onVerifyAvailable(null)
  }, [access.verify, onVerifyAvailable])

  useEffect(() => {
    if (access.state === 'allowed' && wallet?.address) {
      const address = wallet.address as Address
      if (!value || value === lastSuggested.current) {
        lastSuggested.current = address
        onAddress(address, access.key, generation)
      }
    } else if (lastSuggested.current && value === lastSuggested.current) {
      // Clear only the address we suggested; preserve any address the user entered manually.
      lastSuggested.current = null
      onAddress('', access.key, generation)
    }
  }, [access.key, access.state, generation, onAddress, value, wallet?.address])

  if (!ready || access.state === 'checking') return <p role="status" className="text-xs text-faint">Checking your wallet access…</p>
  if (access.state !== 'allowed') return <p role="status" className="text-xs leading-relaxed text-dim">Sign in to the RETEMPO account linked to this wallet to see a suggested address.</p>
  if (!wallet?.address) return <p className="text-xs leading-relaxed text-faint">A RETEMPO wallet address will appear here when available. You can skip this step or add a public address later.</p>

  return (
    <p role="status" className="rounded-lg border border-line bg-midnight/50 p-3 text-xs leading-relaxed text-dim">
      Suggested from your RETEMPO wallet: <span className="mono mt-1 block break-all text-fg">{wallet.address}</span>
    </p>
  )
}

export function EmbeddedWalletSettings() {
  const { authenticated, hasRetempoSession, state: accessState, verify } = useCurrentWalletAccess()
  const { wallets, ready: walletsReady } = useWallets()
  const { createWallet } = useCreateWallet()
  const { exportWallet } = useExportWallet()
  const [creating, setCreating] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const wallet = embeddedEvmWallet(wallets)

  const verifyBeforeAction = async () => {
    const allowed = await verify()
    if (!allowed) setError('This wallet is not linked to the active RETEMPO account. Use the linked sign-in, or link the intended one in Account settings.')
    return allowed
  }

  const copyAddress = async () => {
    if (!wallet?.address || !(await verifyBeforeAction())) return
    try {
      await navigator.clipboard.writeText(wallet.address)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('Could not copy the address. Select and copy it manually.')
    }
  }

  const create = async () => {
    if (!(await verifyBeforeAction())) return
    setCreating(true)
    setError(undefined)
    try {
      await createWallet()
    } catch {
      setError('Could not create a RETEMPO wallet. Please try again.')
    } finally {
      setCreating(false)
    }
  }

  const exportKey = async () => {
    if (!wallet?.address || !(await verifyBeforeAction())) return
    setExporting(true)
    setError(undefined)
    try {
      await exportWallet({ address: wallet.address })
    } catch {
      setError('Could not open the secure export window. Please try again.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <Card>
      <CardHeader title="RETEMPO wallet" description="Your wallet address and secure export options." />
      <CardBody className="space-y-4">
        {!walletsReady || accessState === 'checking' ? (
          <p role="status" className="text-sm text-dim">Checking wallet access…</p>
        ) : !authenticated || !hasRetempoSession ? (
          <p className="text-sm leading-relaxed text-dim">Sign in to the RETEMPO account linked to your wallet to manage it here.</p>
        ) : accessState !== 'allowed' ? (
          <p role="status" className="text-sm leading-relaxed text-dim">This sign-in is not linked to the current RETEMPO account. Wallet details stay hidden. Verify or link the intended sign-in in Account settings.</p>
        ) : wallet ? (
          <>
            <div className="rounded-xl border border-line bg-midnight/50 p-3">
              <p className="text-xs text-faint">Embedded wallet address</p>
              <p className="mono mt-2 break-all text-sm text-fg">{wallet.address}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button type="button" variant="secondary" className="w-full" icon={<Copy className="size-4" />} onClick={() => void copyAddress()}>
                {copied ? 'Copied' : 'Copy address'}
              </Button>
              <Button type="button" className="w-full" loading={exporting} icon={<KeyRound className="size-4" />} onClick={() => void exportKey()}>
                Export private key
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-dim">The export opens a secure wallet window. RETEMPO never receives or stores the private key. Anyone with the key can control this wallet—never share it.</p>
          </>
        ) : (
          <>
            <div className="flex gap-3 rounded-xl border border-line bg-midnight/50 p-3 text-sm text-dim">
              <Wallet className="mt-0.5 size-4 shrink-0 text-cyan" />
              <p>No RETEMPO-managed wallet is available yet. Create one to use the secure export option here.</p>
            </div>
            <Button type="button" variant="secondary" loading={creating} onClick={() => void create()}>
              Create RETEMPO wallet
            </Button>
          </>
        )}
        {error && <p role="alert" className="text-sm text-negative">{error}</p>}
      </CardBody>
    </Card>
  )
}
