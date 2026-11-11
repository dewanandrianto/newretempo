import { Plus, ShieldAlert, Webhook } from 'lucide-react'
import { useBilling } from '@/hooks/useBilling'
import { blockchain } from '@/services/blockchain'
import { buildAddressExplorerUrl, requireChain } from '@/onchain-facts'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/States'
import { PageHeader } from '@/components/ui/PageHeader'
import { QueryBoundary } from '@/components/ui/QueryBoundary'
import { shortAddress } from '@/lib/format'
import { useCan } from '@/features/auth/permissions'
import { ApiKeysCard } from '../ApiKeysCard'

export default function DevelopersPage() {
  const canManage = useCan('apiKeys')
  const query = useBilling('developer', (s) => s.getDeveloper())
  const { network } = blockchain
  const chain = requireChain(network.chainId)
  return (
    <>
      <PageHeader title="Developers" description="API keys, webhooks and network details for integrating RETEMPO." />
      <div className="space-y-4">
        {!canManage ? (
          <Card>
            <EmptyState icon={<ShieldAlert className="size-5" />} title="Admins only" description="API keys and webhooks are managed by organization owners and admins." />
          </Card>
        ) : (
        <QueryBoundary query={query} skeleton="page">
          {(dev) => (
            <div className="grid gap-4 xl:grid-cols-2">
              <ApiKeysCard keys={dev.apiKeys} />
              <Card>
                <CardHeader
                  title="Webhooks"
                  action={
                    <Button size="sm" variant="secondary" disabled icon={<Plus className="size-4" />}>
                      Add endpoint
                    </Button>
                  }
                />
                {dev.webhooks.length === 0 && (
                  <EmptyState
                    icon={<Webhook className="size-5" />}
                    title="No webhook endpoints"
                    description="Webhook endpoints are not available yet. They arrive with verified chain events."
                  />
                )}
              </Card>
            </div>
          )}
        </QueryBoundary>
        )}

        <Card>
          <CardHeader title="Network" description="Verified connection settings for this workspace" />
          <CardBody>
            <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
              {[
                ['Network', 'Configured network'],
                ['Chain ID', String(chain.chainId)],
                ['Gas and payment asset', 'USDC'],
                ['Connection', 'Managed by RETEMPO'],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-faint">{k}</dt>
                  <dd className="mono mt-1 truncate text-fg">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-sm text-dim">
              USDC contract:{' '}
              <a
                className="mono text-cyan hover:text-cyan-soft"
                href={buildAddressExplorerUrl(network.chainId, network.usdcAddress)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {shortAddress(network.usdcAddress)}
              </a>
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="SDK examples" description="No SDK is published in this beta." />
          <CardBody>
            <EmptyState title="No integration examples available" description="Retempo SDK examples and webhook delivery are unavailable in this beta." />
          </CardBody>
        </Card>
      </div>
    </>
  )
}
