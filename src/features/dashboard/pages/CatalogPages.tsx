import { Archive, ArchiveRestore, Trash2 } from 'lucide-react'
import { PublishPlanAction } from '@/features/onchain/MerchantActions'
import type { Plan, Product } from '@shared/types'
import { useBilling } from '@/hooks/useBilling'
import { merchant } from '@/services/merchant/api'
import { fmtDate, fmtUsdc } from '@/lib/format'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import type { Column } from '@/components/ui/DataTable'
import { ROLE_REASON, useCan } from '@/features/auth/permissions'
import { ConfirmAction, CreateDialog, useMerchantMutation } from '../actions'
import { PlanForm, ProductForm } from '../forms/CatalogForms'
import { ListPage } from '../ListPage'

function ProductActions({ product }: { product: Product }) {
  const can = useCan('catalog')
  const toggle = useMerchantMutation(
    (status: 'active' | 'archived') => merchant.products.update(product.id, { status }),
    product.status === 'active' ? 'Product archived' : 'Product restored',
  )
  const remove = useMerchantMutation(() => merchant.products.remove(product.id), 'Product deleted')
  if (!can) return null
  const archived = product.status === 'archived'
  return (
    <div className="flex justify-end gap-1">
      <ConfirmAction
        label={archived ? 'Restore' : 'Archive'}
        icon={archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
        title={archived ? 'Restore this product?' : 'Archive this product?'}
        description={archived ? 'It will be available for new plans again.' : 'Archived products cannot get new plans. Existing plans are unaffected.'}
        confirmLabel={archived ? 'Restore' : 'Archive'}
        tone="secondary"
        onConfirm={() => toggle.mutateAsync(archived ? 'active' : 'archived')}
      />
      <ConfirmAction
        label="Delete"
        icon={<Trash2 className="size-4" />}
        title="Delete this product?"
        description="This cannot be undone. Products that still have plans cannot be deleted; archive them instead."
        confirmLabel="Delete product"
        onConfirm={() => remove.mutateAsync(undefined)}
      />
    </div>
  )
}

const productColumns: Column<Product>[] = [
  {
    key: 'name',
    header: 'Product',
    render: (p) => (
      <div>
        <p className="font-medium text-fg">{p.name}</p>
        <p className="max-w-xs truncate text-xs text-faint">{p.description || 'No description'}</p>
      </div>
    ),
  },
  { key: 'plans', header: 'Plans', align: 'right', render: (p) => p.planCount },
  { key: 'created', header: 'Created', hideOnMobile: true, render: (p) => fmtDate(p.createdAt) },
  { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
  { key: 'actions', header: '', align: 'right', render: (p) => <ProductActions product={p} /> },
]

export function ProductsPage() {
  const query = useBilling('products', (s) => s.listProducts())
  const can = useCan('catalog')
  return (
    <ListPage
      title="Products"
      description="The software and services you sell on subscription."
      query={query}
      columns={productColumns}
      rowKey={(p) => p.id}
      actions={
        <CreateDialog label="New product" title="New product" description="Group the plans you sell under one product." disabled={!can} disabledReason={ROLE_REASON}>
          {(close) => <ProductForm onDone={close} />}
        </CreateDialog>
      }
      empty={{ title: 'No products yet', description: 'Use New product to create the first thing you sell. Plans attach to products.' }}
      filters={[
        { value: 'active', label: 'Active', match: (p) => p.status === 'active' },
        { value: 'archived', label: 'Archived', match: (p) => p.status === 'archived' },
      ]}
    />
  )
}

function PlanActions({ plan }: { plan: Plan }) {
  const can = useCan('catalog')
  const archive = useMerchantMutation(() => merchant.plans.update(plan.id, { status: plan.status === 'active' ? 'archived' : 'active' }), 'Plan updated')
  const remove = useMerchantMutation(() => merchant.plans.remove(plan.id), 'Plan deleted')
  if (!can) return null
  const archived = plan.status === 'archived'
  return (
    <div className="flex flex-wrap justify-end gap-1">
      <PublishPlanAction plan={plan} />
      <ConfirmAction
        label={archived ? 'Restore' : 'Archive'}
        icon={archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
        title={archived ? 'Restore this plan?' : 'Archive this plan?'}
        description={archived ? 'New subscriptions can use it again.' : 'No new subscriptions can use an archived plan. Existing ones are unaffected.'}
        confirmLabel={archived ? 'Restore' : 'Archive'}
        tone="secondary"
        onConfirm={() => archive.mutateAsync(undefined)}
      />
      <ConfirmAction
        label="Delete"
        icon={<Trash2 className="size-4" />}
        title="Delete this plan?"
        description="Plans with subscriptions cannot be deleted; archive them instead."
        confirmLabel="Delete plan"
        onConfirm={() => remove.mutateAsync(undefined)}
      />
    </div>
  )
}

const planColumns: Column<Plan>[] = [
  {
    key: 'name',
    header: 'Plan',
    render: (p) => (
      <div>
        <p className="font-medium text-fg">{p.name}</p>
        <p className="text-xs text-faint">{p.productName}</p>
      </div>
    ),
  },
  {
    key: 'price',
    header: 'Price',
    align: 'right',
    render: (p) => (
      <span className="text-fg">
        {fmtUsdc(p.amount)} <span className="text-faint">USDC / {p.interval}</span>
      </span>
    ),
  },
  { key: 'trial', header: 'Trial', hideOnMobile: true, render: (p) => (p.trialDays ? `${p.trialDays} days` : 'None') },
  {
    key: 'escrow',
    header: 'Escrow hold',
    hideOnMobile: true,
    render: (p) => (p.escrowDays ? <Badge tone="cyan">{p.escrowDays} days</Badge> : <span className="text-faint">Instant</span>),
  },
  { key: 'subs', header: 'Subscribers', align: 'right', render: (p) => p.subscribers },
  { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
  { key: 'actions', header: '', align: 'right', render: (p) => <PlanActions plan={p} /> },
]

export function PlansPage() {
  const query = useBilling('plans', (s) => s.listPlans())
  const can = useCan('catalog')
  return (
    <ListPage
      title="Subscription Plans"
      description="Pricing, billing intervals, trials and escrow terms for each product."
      query={query}
      columns={planColumns}
      rowKey={(p) => p.id}
      actions={
        <CreateDialog label="New plan" title="New subscription plan" description="Prices are in USDC and stored as exact integer amounts." disabled={!can} disabledReason={ROLE_REASON}>
          {(close) => <PlanForm onDone={close} />}
        </CreateDialog>
      }
      empty={{ title: 'No plans yet', description: 'Create a product, then use New plan to set a USDC price and billing interval.' }}
      filters={[
        { value: 'month', label: 'Monthly', match: (p) => p.interval === 'month' },
        { value: 'year', label: 'Annual', match: (p) => p.interval === 'year' },
        { value: 'week', label: 'Weekly', match: (p) => p.interval === 'week' },
      ]}
    />
  )
}
