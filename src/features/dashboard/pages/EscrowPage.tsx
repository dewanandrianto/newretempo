import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Gavel, HandCoins, Hourglass, ShieldCheck, Trash2 } from 'lucide-react'
import type { EscrowHold } from '@shared/types'
import { useBilling } from '@/hooks/useBilling'
import { blockchain } from '@/services/blockchain'
import { merchant } from '@/services/merchant/api'
import { fmtDate, fmtUsdc } from '@/lib/format'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { PageHeader } from '@/components/ui/PageHeader'
import { QueryBoundary } from '@/components/ui/QueryBoundary'
import { EmptyState, Skeleton } from '@/components/ui/States'
import { ROLE_REASON, useCan } from '@/features/auth/permissions'
import { ConfirmAction, CreateDialog, useMerchantMutation } from '../actions'
import { EscrowForm } from '../forms/BillingForms'
import { MerchantEscrowControls } from '@/features/onchain/MerchantEscrowControls'

function HoldActions({ hold }: { hold: EscrowHold }) {
  const can = useCan('escrows')
  const discard = useMerchantMutation(() => merchant.escrows.remove(hold.id), 'Escrow record discarded')
  if (!can || hold.status !== 'pending_funding') return null
  return (
    <ConfirmAction
      label="Discard"
      icon={<Trash2 className="size-4" />}
      title="Discard this escrow record?"
      description="Only unfunded records can be discarded. The change is kept in the audit trail."
      confirmLabel="Discard record"
      onConfirm={() => discard.mutateAsync(undefined)}
    />
  )
}

const holdColumns: Column<EscrowHold>[] = [
  {
    key: 'customer',
    header: 'Customer',
    render: (h) => (
      <div>
        <p className="font-medium text-fg">{h.customerName}</p>
        <p className="num text-xs text-faint">{h.reference}</p>
      </div>
    ),
  },
  { key: 'release', header: 'Release date', hideOnMobile: true, render: (h) => (h.releaseAt ? fmtDate(h.releaseAt) : <span className="text-faint">Set at funding</span>) },
  { key: 'amount', header: 'Amount', align: 'right', render: (h) => <span className="text-fg">{fmtUsdc(h.amount)} USDC</span> },
  { key: 'status', header: 'Status', render: (h) => <StatusBadge status={h.status} /> },
  { key: 'actions', header: '', align: 'right', render: (h) => <HoldActions hold={h} /> },
]

const lifecycle = [
  { icon: HandCoins, title: 'Customer pays', body: 'USDC is sent for the billing period.' },
  { icon: ShieldCheck, title: 'Held in escrow', body: 'Funds sit in the contract, not with you or us.' },
  { icon: Hourglass, title: 'Release window', body: 'Your plan defines how long funds are held.' },
  { icon: Gavel, title: 'Release or dispute', body: 'Released to you, or paused if disputed.' },
]

function ContractStatus() {
  const { data, isPending, isError } = useQuery({ queryKey: ['escrow-contract'], queryFn: () => blockchain.getEscrowContractState() })
  if (isPending) return <Skeleton className="h-6 w-32" />
  if (isError) return <Badge tone="caution">Status unavailable</Badge>
  return data?.state === 'deployed' ? <Badge tone="positive">Deployed</Badge> : <Badge tone="caution">Not deployed</Badge>
}

export default function EscrowPage() {
  const query = useBilling('escrow', (s) => s.getEscrow())
  const can = useCan('escrows')
  return (
    <>
      <PageHeader
        title="Escrow"
        description="Escrow records for invoices. Funding and release are controlled only by verified blockchain events."
        actions={
          <CreateDialog label="New escrow record" title="New escrow record" disabled={!can} disabledReason={ROLE_REASON}>
            {(close) => <EscrowForm onDone={close} />}
          </CreateDialog>
        }
      />
      <div className="space-y-4">
        <MerchantEscrowControls />
        <Card>
          <CardHeader title="Escrow contract" description={`Network: ${blockchain.network.name}`} action={<ContractStatus />} />
          <CardBody>
            <p className="max-w-2xl text-sm text-dim">
              Balances and claimable amounts come from contract getters at the verified indexed block, not estimated vesting.
              Pending funding records do not count as held funds. Dispute-frozen funds are shown separately from claimable credits.
            </p>
            <ol className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {lifecycle.map((s, i) => (
                <li key={s.title} className="relative rounded-xl border border-line bg-midnight/50 p-4">
                  <div className="flex items-center justify-between">
                    <span className="flex size-9 items-center justify-center rounded-xl bg-cyan/10 text-cyan">
                      <s.icon className="size-4" />
                    </span>
                    {i < lifecycle.length - 1 && <ArrowRight className="hidden size-4 text-faint xl:block" />}
                  </div>
                  <p className="mt-3 text-sm font-medium text-fg">{s.title}</p>
                  <p className="mt-1 text-xs text-dim">{s.body}</p>
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>

        <QueryBoundary query={query} skeleton="page">
          {(e) => (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  { label: 'Held in escrow', value: e.held, tone: 'text-cyan' },
                  { label: 'Claimable', value: e.releasable, tone: 'text-positive' },
                  { label: 'Pending funding', value: e.pendingFunding, tone: 'text-fg' },
                  { label: 'Frozen by dispute', value: e.disputed, tone: 'text-caution' },
                ].map((s) => (
                  <Card key={s.label} className="p-5">
                    <p className="text-sm text-dim">{s.label}</p>
                    <p className={`display num mt-2 text-3xl font-semibold ${s.tone}`}>
                      {fmtUsdc(s.value)} <span className="text-sm font-medium text-faint">USDC</span>
                    </p>
                  </Card>
                ))}
              </div>
              <Card className="overflow-hidden">
                <CardHeader title="Escrow records" description="Every create and discard is kept in the audit trail" className="pb-4" />
                {e.holds.length === 0 ? (
                  <EmptyState title="No escrow records" description="Finalize an invoice, then use New escrow record to prepare it for escrow." />
                ) : (
                  <div className="mt-2">
                    <DataTable columns={holdColumns} rows={e.holds} rowKey={(h) => h.id} />
                  </div>
                )}
              </Card>
            </>
          )}
        </QueryBoundary>
      </div>
    </>
  )
}
