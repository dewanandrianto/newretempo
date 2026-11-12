import { useState } from 'react'
import { useConnectWallet, useWallets, type ConnectedWallet } from '@privy-io/react-auth'
import { useSetActiveWallet } from '@privy-io/wagmi'
import { useAccount } from 'wagmi'
import { Button } from '@/components/ui/Button'

export function PrivyCustomerWalletPicker() {
  const { address } = useAccount()
  const { wallets, ready } = useWallets()
  const { setActiveWallet } = useSetActiveWallet()
  const [connecting, setConnecting] = useState(false)
  const [selecting, setSelecting] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const { connectWallet } = useConnectWallet({
    onSuccess: () => {
      setConnecting(false)
      setNotice('Wallet connected. Review the selected address before verifying ownership.')
    },
    onError: () => {
      setConnecting(false)
      setError('Wallet connection was cancelled or could not be completed.')
    },
  })

  const choose = async (wallet: ConnectedWallet) => {
    setSelecting(wallet.address)
    setError(undefined)
    setNotice(undefined)
    try {
      await setActiveWallet(wallet)
      setNotice('Customer wallet selected. Ownership verification is a separate step.')
    } catch {
      setError('This wallet could not be selected. Please try again.')
    } finally {
      setSelecting(undefined)
    }
  }

  const connect = () => {
    setConnecting(true)
    setError(undefined)
    setNotice(undefined)
    try {
      connectWallet({ walletChainType: 'ethereum-only' })
    } catch {
      setConnecting(false)
      setError('Wallet options could not be opened. Please try again.')
    }
  }

  if (!ready) return <p role="status" className="text-sm text-dim">Loading wallet options…</p>

  return (
    <section aria-label="Customer wallet selection" className="space-y-3 rounded-lg border border-line p-3">
      <h3 className="text-sm font-medium text-fg">Choose a customer wallet</h3>
      {(wallets.length > 1 || !address) && wallets.map((wallet) => {
        const active = wallet.address.toLowerCase() === address?.toLowerCase()
        return (
          <Button key={wallet.address} type="button" variant="secondary" className="h-auto w-full min-w-0 py-2 text-left" aria-pressed={active} disabled={active || connecting || Boolean(selecting)} loading={selecting === wallet.address} onClick={() => void choose(wallet)}>
            <span className="min-w-0 whitespace-normal"><span className="block text-xs">{active ? 'Selected wallet' : 'Use this wallet'}</span><span className="mono block break-all text-xs">{wallet.address}</span></span>
          </Button>
        )
      })}
      <Button type="button" variant="secondary" className="w-full" loading={connecting} disabled={Boolean(selecting)} onClick={connect}>Connect another wallet</Button>
      <p className="text-xs leading-relaxed text-dim">Connecting or selecting a wallet does not change your sign-in, link a customer record, or approve a payment. Use a different wallet from the merchant.</p>
      {notice && <p role="status" className="text-xs text-positive">{notice}</p>}
      {error && <p role="alert" className="text-xs text-negative">{error}</p>}
    </section>
  )
}
