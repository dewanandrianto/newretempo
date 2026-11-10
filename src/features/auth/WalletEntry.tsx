import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ConnectKitButton } from 'connectkit'
import { useSignMessage } from 'wagmi'
import { Wallet } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { errorMessage } from '@/services/api/client'
import { shortAddress } from '@/lib/format'
import { useAuth } from './AuthProvider'

const isRejection = (err: unknown) => /user rejected|denied|cancel/i.test(err instanceof Error ? err.message : '')

/**
 * Wallet sign-in with Sign-In with Ethereum (EIP-4361).
 * A connected address alone proves nothing: the wallet must sign a one-time message that
 * the server issued, and the server verifies the signature before creating a session.
 */
export function WalletEntry() {
  const { requestWalletChallenge, verifyWalletSignature } = useAuth()
  const { signMessageAsync } = useSignMessage()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const signIn = async (address: `0x${string}`) => {
    setBusy(true)
    setError(undefined)
    try {
      const { message } = await requestWalletChallenge(address)
      const signature = await signMessageAsync({ message })
      const session = await verifyWalletSignature({ message, signature })
      void navigate(session.organization ? '/app' : '/onboarding')
    } catch (err) {
      if (!isRejection(err)) setError(errorMessage(err, 'Wallet sign-in failed. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <ConnectKitButton.Custom>
        {({ isConnected, isConnecting, show, address }) =>
          isConnected && address ? (
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              loading={busy}
              icon={<Wallet className="size-4" />}
              onClick={() => void signIn(address)}
            >
              {busy ? 'Check your wallet to sign' : `Sign in as ${shortAddress(address)}`}
            </Button>
          ) : (
            <Button variant="secondary" size="lg" className="w-full" loading={isConnecting} icon={<Wallet className="size-4" />} onClick={show}>
              Continue with wallet
            </Button>
          )
        }
      </ConnectKitButton.Custom>
      {error && (
        <p role="alert" className="mt-2 text-sm text-negative">
          {error}
        </p>
      )}
      <p className="mt-2 text-xs text-faint">You will sign a message. It costs no gas and sends no transaction.</p>
    </div>
  )
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
