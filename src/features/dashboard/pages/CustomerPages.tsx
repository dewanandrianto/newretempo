import { ArchiveRestore, Trash2 } from 'lucide-react'
import { CheckoutLinkAction, MerchantSubscriptionAction } from '@/features/onchain/MerchantActions'
import type { Customer, Subscription } from '@shared/types'
import { useBilling } from '@/hooks/useBilling'
import { merchant } from '@/services/merchant/api'
import { fmtDate, fmtUsdc, initials } from '@/lib/format'
import { StatusBadge } from '@/components/ui/Badge'
import type { Column } from '@/components/ui/DataTable'
import { ROLE_REASON, useCan } from '@/features/auth/permissions'
import { ConfirmAction, CreateDialog, useMerchantMutation } from '../actions'
import { CustomerForm, SubscriptionForm } from '../forms/CatalogForms'
import { ListPage } from '../ListPage'

function CustomerActions({ customer }: { customer: Customer }) {
  const can = useCan('customers')
  const canDelete = useCan('catalog')
  const archive = useMerchantMutation(() => merchant.customers.update(customer.id, { status: 'archived' }), 'Customer archived')
  const remove = useMerchantMutation(() => merchant.customers.remove(customer.id), 'Customer deleted')
  if (!can) return null
  return (
    <div className="flex justify-end gap-1">
      <ConfirmAction
        label="Archive"
        icon={<ArchiveRestore className="size-4" />}
        title="Archive this customer?"
        description="Archived customers stay in your records but cannot get new subscriptions or invoices."
        confirmLabel="Archive"
        tone="secondary"
        onConfirm={() => archive.mutateAsync(undefined)}
      />
      {canDelete && (
        <ConfirmAction
          label="Delete"
          icon={<Trash2 className="size-4" />}
          title="Delete this customer?"
          description="Customers with subscriptions or invoices cannot be deleted; archive them instead."
          confirmLabel="Delete customer"
          onConfirm={() => remove.mutateAsync(undefined)}
        />
      )}
    </div>
  )
}

const customerColumns: Column<Customer>[] = [
  {
    key: 'name',
    header: 'Customer',
    render: (c) => (
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-electric/15 text-xs font-semibold text-electric-soft">
          {initials(c.company)}
        </span>
        <div className="min-w-0">
          <p className="truncate font-medium text-fg">{c.company}</p>
          <p className="truncate text-xs text-faint">
            {c.name} · {c.email}
          </p>
        </div>
      </div>
    ),
  },
  { key: 'since', header: 'Customer since', hideOnMobile: true, render: (c) => fmtDate(c.createdAt) },
  { key: 'subs', header: 'Open subs', align: 'right', render: (c) => c.activeSubscriptions },
  { key: 'ltv', header: 'Confirmed payments', align: 'right', render: (c) => <span className="text-fg">{fmtUsdc(c.lifetimeValue)} USDC</span> },
  { key: 'actions', header: '', align: 'right', render: (c) => <CustomerActions customer={c} /> },
]

export function CustomersPage() {
  const query = useBilling('customers', (s) => s.listCustomers())
  const can = useCan('customers')
  return (
    <ListPage
      title="Customers"
      description="The businesses and people who pay you."
      query={query}
      columns={customerColumns}
      rowKey={(c) => c.id}
      actions={
        <CreateDialog label="Add customer" title="Add a customer" disabled={!can} disabledReason={ROLE_REASON}>
          {(close) => <CustomerForm onDone={close} />}
        </CreateDialog>
      }
      empty={{ title: 'No customers yet', description: 'Use Add customer to record who you bill.' }}
    />
  )
}

function SubscriptionActions({ sub }: { sub: Subscription }) {
  const can = useCan('subscriptions')
  const remove = useMerchantMutation(() => merchant.subscriptions.remove(sub.id), 'Subscription deleted')
  if (!can) return null
  const canceled = sub.status === 'canceled'
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {!canceled && <CheckoutLinkAction subscriptionId={sub.id} />}
      {!canceled && <MerchantSubscriptionAction subscriptionId={sub.id} />}
      {(canceled || sub.status === 'incomplete') && (
        <ConfirmAction
          label="Delete"
          icon={<Trash2 className="size-4" />}
          title="Delete this subscription?"
          description="Subscriptions with invoices cannot be deleted."
          confirmLabel="Delete"
          onConfirm={() => remove.mutateAsync(undefined)}
        />
      )}
    </div>
  )
}

const subscriptionColumns: Column<Subscription>[] = [
  {
    key: 'customer',
    header: 'Customer',
    render: (s) => (
      <div>
        <p className="font-medium text-fg">{s.customerName}</p>
        <p className="num max-w-[11rem] truncate text-xs text-faint">{s.id}</p>
      </div>
    ),
  },
  { key: 'plan', header: 'Plan', render: (s) => s.planName },
  {
    key: 'amount',
    header: 'Amount',
    align: 'right',
    render: (s) => (
      <span className="text-fg">
        {fmtUsdc(s.amount)} <span className="text-faint">/ {s.interval}</span>
      </span>
    ),
  },
  { key: 'renews', header: 'Next billing', hideOnMobile: true, render: (s) => (s.currentPeriodEnd ? fmtDate(s.currentPeriodEnd) : <span className="text-faint">Not started</span>) },
  { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
  { key: 'actions', header: '', align: 'right', render: (s) => <SubscriptionActions sub={s} /> },
]

export function SubscriptionsPage() {
  const query = useBilling('subscriptions', (s) => s.listSubscriptions())
  const can = useCan('subscriptions')
  return (
    <ListPage
      title="Subscriptions"
      description="Subscription records with secure checkout capabilities. Activation, renewal and cancellation require verified onchain transactions."
      query={query}
      columns={subscriptionColumns}
      rowKey={(s) => s.id}
      actions={
        <CreateDialog label="New subscription" title="New subscription" disabled={!can} disabledReason={ROLE_REASON}>
          {(close) => <SubscriptionForm onDone={close} />}
        </CreateDialog>
      }
      empty={{ title: 'No subscriptions yet', description: 'Use New subscription to attach a customer to a plan.' }}
      filters={[
        { value: 'incomplete', label: 'Incomplete', match: (s) => s.status === 'incomplete' },
        { value: 'active', label: 'Active', match: (s) => s.status === 'active' || s.status === 'trialing' },
        { value: 'attention', label: 'Needs attention', match: (s) => s.status === 'past_due' || s.status === 'paused' },
        { value: 'canceled', label: 'Canceled', match: (s) => s.status === 'canceled' },
      ]}
    />
  )
}
