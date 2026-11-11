import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccount, useConnect, useSignMessage } from 'wagmi'
import { Wallet } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { errorMessage } from '@/services/api/client'
import { useAuth } from './AuthProvider'

const isRejection = (err: unknown) => /user rejected|denied|cancel/i.test(err instanceof Error ? err.message : '')
type Address = `0x${string}`

function useLegacySiweSignIn() {
  const { requestWalletChallenge, verifyWalletSignature } = useAuth()
  const { signMessageAsync } = useSignMessage()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const signIn = useCallback(async (address: Address) => {
    setBusy(true)
    setError(undefined)
    try {
      const { message } = await requestWalletChallenge(address)
      const signature = await signMessageAsync({ message, account: address })
      const session = await verifyWalletSignature({ message, signature })
      await navigate(session.organization ? '/app' : '/onboarding')
    } catch (err) {
      if (!isRejection(err)) setError(errorMessage(err, 'Wallet recovery failed. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [navigate, requestWalletChallenge, signMessageAsync, verifyWalletSignature])

  return { signIn, busy, error, setError }
}

/** Legacy injected-wallet recovery is shown only while the unified Privy flow is disabled. */
function LegacyWalletRecovery() {
  const { address, isConnected } = useAccount()
  const { connectors, connectAsync, isPending } = useConnect()
  const { signIn, busy, error, setError } = useLegacySiweSignIn()

  const start = () => {
    void (async () => {
      setError(undefined)
      if (isConnected && address) {
        await signIn(address)
        return
      }
      const connector = connectors.find((item) => item.id === 'injected') ?? connectors[0]
      if (!connector) {
        setError('No browser wallet is available. Enable a wallet extension and try again.')
        return
      }
      try {
        const result = await connectAsync({ connector })
        const connectedAddress = result.accounts[0]
        if (connectedAddress) await signIn(connectedAddress)
      } catch (err) {
        if (!isRejection(err)) setError(errorMessage(err, 'Wallet recovery failed. Please try again.'))
      }
    })()
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="secondary" size="lg" className="w-full" loading={isPending || busy} icon={<Wallet className="size-4" />} onClick={start}>
        {busy ? 'Verifying existing wallet…' : 'Recover an existing wallet account'}
      </Button>
      <p className="text-xs text-faint">You will sign a one-time message; no gas or transaction is involved.</p>
      {error && <p role="alert" className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">{error}</p>}
    </div>
  )
}

export function WalletEntry({ privyEnabled }: { privyEnabled: boolean }) {
  return privyEnabled ? null : <LegacyWalletRecovery />
}

export function OrDivider() {
  return (
    <div className="my-6 flex items-center gap-3 text-xs text-faint">
      <span className="h-px flex-1 bg-line" />
      or
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}
