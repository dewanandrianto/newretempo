import { ConnectKitButton } from 'connectkit'
import { useAccount, useSwitchChain } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Wallet } from 'lucide-react'
import { blockchain } from '@/services/blockchain'
import { shortAddress } from '@/lib/format'
import { Button } from '@/components/ui/Button'

const { network } = blockchain

/** Balance comes from the configured reader, not Wagmi's unrelated default RPC. */
export function useUsdcBalance() {
  const { address } = useAccount()
  const query = useQuery({
    queryKey: ['configured-usdc-balance', address],
    queryFn: () => blockchain.getUsdcBalance(address!),
    enabled: Boolean(address),
    refetchInterval: 15000,
    retry: false,
  })
  return { ...query, formatted: query.data }
}

export function WalletButton({ compact = false }: { compact?: boolean }) {
  const { chainId, isConnected } = useAccount()
  const { switchChain, isPending } = useSwitchChain()
  const { formatted } = useUsdcBalance()
  const wrongChain = isConnected && chainId !== network.chainId

  return (
    <ConnectKitButton.Custom>
      {({ isConnected: connected, isConnecting, show, address }) => {
        if (connected && wrongChain) {
          return (
            <Button
              variant="secondary"
              size="sm"
              loading={isPending}
              icon={<AlertTriangle className="size-4 text-caution" />}
              onClick={() => switchChain({ chainId: network.chainId })}
            >
              Switch to {network.name}
            </Button>
          )
        }
        if (connected && address) {
          return (
            <button
              type="button"
              onClick={show}
              className="inline-flex h-9 items-center gap-2.5 rounded-xl border border-line-strong bg-raised pr-3 pl-1.5 text-sm text-fg transition-colors hover:border-cyan/40"
            >
              <span className={`num rounded-lg bg-midnight px-2 py-1 text-xs text-cyan ${compact ? 'hidden sm:inline-block' : ''}`}>
                {formatted ?? '...'}
                {!compact && ' USDC'}
              </span>
              <span className="mono text-xs text-dim">{shortAddress(address)}</span>
            </button>
          )
        }
        return (
          <Button variant="secondary" size="sm" loading={isConnecting} onClick={show} icon={<Wallet className="size-4" />}>
            Connect wallet
          </Button>
        )
      }}
    </ConnectKitButton.Custom>
  )
}
