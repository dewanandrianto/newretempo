import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDownLeft, ArrowUpRight, Banknote, Landmark, Repeat, TrendingUp, FileClock } from 'lucide-react'
import type { DashboardOverview, LedgerEntry } from '@shared/types'
import { useBilling } from '@/hooks/useBilling'
import { fmtNumber, fmtShortDate, fmtUsdc } from '@/lib/format'
import { PageHeader } from '@/components/ui/PageHeader'
import { formatBaseUnits } from '@shared/money'
import { QueryBoundary } from '@/components/ui/QueryBoundary'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { StatCard } from '@/components/ui/Stat'
import { Segmented } from '@/components/ui/Segmented'
import { StatusBadge } from '@/components/ui/Badge'
import { LinkButton } from '@/components/ui/Button'
import { AreaChart } from '@/components/charts/AreaChart'
import { Donut } from '@/components/charts/Donut'

const PLAN_COLORS = ['#3B82F6', '#22D3EE', '#6EA1FF', '#7CE7F7', '#2158C9']

export function RevenueCard({ data }: { data: DashboardOverview }) {
  const [range, setRange] = useState<'6' | '12'>('12')
  const series = data.revenueSeries.slice(-Number(range))
  const total = formatBaseUnits(series.reduce((s, p) => s + BigInt(p.baseUnits ?? '0'), 0n))
  return (
    <Card className="xl:col-span-2">
      <CardHeader
        title="Revenue"
        description="Verified subscription and direct escrow payments"
        action={
          <Segmented
            label="Range"
            value={range}
            onChange={setRange}
            options={[
              { value: '6', label: '6M' },
              { value: '12', label: '12M' },
            ]}
          />
        }
      />
      <CardBody>
        <p className="display num text-3xl font-semibold text-fg">
          {fmtUsdc(total)} <span className="text-base font-medium text-faint">USDC</span>
        </p>
        <p className="mt-1 mb-5 text-xs text-faint">Last {range} months</p>
        <AreaChart data={series} height={250} formatValue={(v) => fmtUsdc(v, { compact: true })} />
      </CardBody>
    </Card>
  )
}

const kindMeta: Record<LedgerEntry['kind'], { label: string }> = {
  payment: { label: 'Payment' },
  payout: { label: 'Payout' },
  refund: { label: 'Refund' },
  escrow_hold: { label: 'Escrow hold' },
  escrow_release: { label: 'Escrow release' },
}

export function RecentTransactions({ rows }: { rows: LedgerEntry[] }) {
  return (
    <ul className="divide-y divide-line/60">
      {rows.length === 0 && <li className="px-6 py-8 text-sm text-faint">No verified transactions yet.</li>}
      {rows.map((t) => (
        <li key={t.id} className="flex items-center gap-3 px-5 py-3.5 sm:px-6">
          <span
            className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${t.direction === 'in' ? 'bg-positive/10 text-positive' : 'bg-white/5 text-dim'}`}
          >
            {t.direction === 'in' ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-fg">{t.counterparty}</p>
            <p className="text-xs text-faint">
              {kindMeta[t.kind].label} · {fmtShortDate(t.createdAt)}
            </p>
          </div>
          <div className="text-right">
            <p className="num text-sm font-medium text-fg">
              {t.direction === 'in' ? '+' : '-'}
              {fmtUsdc(t.amount)}
            </p>
            <div className="mt-0.5">
              <StatusBadge status={t.status} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function OverviewPage() {
  const query = useBilling('overview', (s) => s.getOverview())
  return (
    <>
      <PageHeader
        title="Overview"
        description="Revenue, subscriptions and escrow at a glance."
        actions={
          <LinkButton to="/app/plans" size="sm">
            Create a plan
          </LinkButton>
        }
      />
      <QueryBoundary query={query} skeleton="page">
        {(d) => (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Total revenue" value={fmtUsdc(d.totalRevenue, { whole: true })} unit="USDC" caption="Verified gross collections" icon={<Banknote className="size-4" />} />
              <StatCard label="Monthly recurring revenue" value={fmtUsdc(d.mrr, { whole: true })} unit="USDC" caption="Current active subscription run rate" icon={<TrendingUp className="size-4" />} />
              <StatCard label="Active subscriptions" value={fmtNumber(d.activeSubscriptions)} caption="Current active records" icon={<Repeat className="size-4" />} />
              <StatCard label="Pending invoices" value={fmtNumber(d.pendingInvoices)} caption={`${fmtUsdc(d.pendingInvoicesAmount)} USDC outstanding`} icon={<FileClock className="size-4" />} />
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              <RevenueCard data={d} />
              <div className="grid grid-cols-1 gap-4">
                <Card className="p-5 sm:p-6">
                  <div className="flex items-center justify-between text-dim">
                    <span className="text-sm">Escrow balance</span>
                    <Landmark className="size-4 text-faint" />
                  </div>
                  <p className="display num mt-3 text-3xl font-semibold text-fg">
                    {fmtUsdc(d.escrowBalance)} <span className="text-sm font-medium text-faint">USDC</span>
                  </p>
                  <p className="mt-2 text-xs text-faint">Balance at the verified indexed block; excludes withdrawable credits.</p>
                  <Link to="/app/escrow" className="mt-4 inline-block text-sm font-medium text-cyan hover:text-cyan-soft">
                    View escrow
                  </Link>
                </Card>
                <Card>
                  <CardHeader title="Plan mix" description="Subscribers by plan family" />
                  <CardBody>
                    <Donut
                      centerLabel="subscribers"
                      centerValue={fmtNumber(d.planMix.reduce((s, p) => s + p.value, 0))}
                      slices={d.planMix.map((p, i) => ({ ...p, color: PLAN_COLORS[i % PLAN_COLORS.length] }))}
                    />
                  </CardBody>
                </Card>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader
                  title="Recent transactions"
                  description="Latest ledger entries"
                  action={
                    <Link to="/app/transactions" className="text-sm font-medium text-cyan hover:text-cyan-soft">
                      View all
                    </Link>
                  }
                />
                <div className="mt-3">
                  <RecentTransactions rows={d.recent} />
                </div>
              </Card>
            </div>
          </div>
        )}
      </QueryBoundary>
    </>
  )
}
