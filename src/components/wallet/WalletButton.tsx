import { useAccount, useConnect, useSwitchChain } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { blockchain } from '@/services/blockchain'
import { configuredArcTestnet } from '@/services/blockchain/chainConfig'
import { shortAddress } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { useRuntimeAuthConfig } from '@/features/auth/privyRuntimeContext'

const expectedChainId = configuredArcTestnet.id

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

/** Read-only wallet status. Wallet selection and authentication happen through Privy. */
export function WalletButton({ compact = false }: { compact?: boolean }) {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { connectors, connectAsync, isPending: connecting } = useConnect()
  const { enabled: privyEnabled } = useRuntimeAuthConfig()
  const { formatted } = useUsdcBalance()
  const wrongChain = isConnected && chainId !== expectedChainId

  if (!address) {
    // Local-only wallet hook for the repository's browser harness; never present in production builds.
    if (import.meta.env.DEV && !privyEnabled) {
      return (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={connecting}
          onClick={() => {
            const connector = connectors.find((item) => item.id === 'injected') ?? connectors[0]
            if (connector) void connectAsync({ connector }).catch(() => undefined)
          }}
        >
          Connect test wallet
        </Button>
      )
    }
    return null
  }

  if (wrongChain) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        loading={switching}
        icon={<AlertTriangle className="size-4 text-caution" />}
        onClick={() => switchChain({ chainId: expectedChainId })}
      >
        Switch network
      </Button>
    )
  }

  return (
    <div
      aria-label={`Active wallet ${shortAddress(address)}`}
      className="inline-flex h-9 min-w-0 items-center gap-2.5 rounded-xl border border-line-strong bg-raised pr-3 pl-2 text-sm text-fg"
    >
      <span className={`num rounded-lg bg-midnight px-2 py-1 text-xs text-cyan ${compact ? 'hidden sm:inline-block' : ''}`}>
        {formatted ?? '—'}
        {!compact && ' USDC'}
      </span>
      <span className="mono text-xs text-dim">{shortAddress(address)}</span>
    </div>
  )
}
