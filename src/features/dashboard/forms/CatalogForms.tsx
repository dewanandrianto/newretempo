import { useState, type FormEvent } from 'react'
import { useBilling } from '@/hooks/useBilling'
import { merchant } from '@/services/merchant/api'
import { SelectField, TextField } from '@/components/ui/Field'
import { useMerchantMutation } from '../actions'
import { FormFooter, toBaseUnits } from './shared'

interface FormProps {
  onDone: () => void
}

export function ProductForm({ onDone }: FormProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const m = useMerchantMutation((v: { name: string; description: string }) => merchant.products.create(v), 'Product created', onDone, true)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    m.mutate({ name, description })
  }
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <TextField label="Product name" value={name} onChange={(e) => setName(e.target.value)} error={m.fields.name} autoFocus />
      <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} error={m.fields.description} hint="Optional. Shown to customers at checkout." />
      <FormFooter label="Create product" busy={m.isPending} error={m.formError} onCancel={onDone} />
    </form>
  )
}

export function PlanForm({ onDone }: FormProps) {
  const products = useBilling('products', (s) => s.listProducts())
  const active = (products.data?.data ?? []).filter((p) => p.status === 'active')
  const [productId, setProductId] = useState('')
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [interval, setInterval] = useState('month')
  const [trialDays, setTrialDays] = useState('0')
  const [escrowDays, setEscrowDays] = useState('0')
  const [localError, setLocalError] = useState<string>()
  const m = useMerchantMutation(merchant.plans.create, 'Plan created', onDone, true)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const amount = toBaseUnits(price)
    if (!amount.value) return setLocalError(amount.error)
    setLocalError(undefined)
    m.mutate({
      productId: productId || active[0]?.id || '',
      name,
      amount: amount.value,
      interval: interval as 'week' | 'month' | 'year',
      trialDays: Number(trialDays) || 0,
      escrowDays: Number(escrowDays) || 0,
    })
  }

  if (!products.isPending && active.length === 0) {
    return <p className="text-sm text-dim">Create an active product first. Plans belong to a product.</p>
  }
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <SelectField label="Product" value={productId || active[0]?.id || ''} onChange={(e) => setProductId(e.target.value)} options={active.map((p) => ({ value: p.id, label: p.name }))} error={m.fields.productId} />
      <TextField label="Plan name" value={name} onChange={(e) => setName(e.target.value)} error={m.fields.name} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Price (USDC)" inputMode="decimal" placeholder="49.00" value={price} onChange={(e) => setPrice(e.target.value)} error={localError ?? m.fields.amount} />
        <SelectField
          label="Billing interval"
          value={interval}
          onChange={(e) => setInterval(e.target.value)}
          options={[
            { value: 'week', label: 'Weekly' },
            { value: 'month', label: 'Monthly' },
            { value: 'year', label: 'Annual' },
          ]}
        />
        <TextField label="Trial days" inputMode="numeric" value={trialDays} onChange={(e) => setTrialDays(e.target.value)} error={m.fields.trialDays} />
        <TextField label="Escrow hold (days)" inputMode="numeric" value={escrowDays} onChange={(e) => setEscrowDays(e.target.value)} error={m.fields.escrowDays} hint="Applies once escrow contracts exist." />
      </div>
      <FormFooter label="Create plan" busy={m.isPending} error={m.formError} onCancel={onDone} />
    </form>
  )
}

export function CustomerForm({ onDone }: FormProps) {
  const [form, setForm] = useState({ name: '', email: '', company: '' })
  const m = useMerchantMutation(merchant.customers.create, 'Customer added', onDone, true)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate(form)
      }}
      className="space-y-4"
      noValidate
    >
      <TextField label="Contact name" value={form.name} onChange={set('name')} error={m.fields.name} autoFocus />
      <TextField label="Email" type="email" value={form.email} onChange={set('email')} error={m.fields.email} />
      <TextField label="Company (optional)" value={form.company} onChange={set('company')} error={m.fields.company} />
      <FormFooter label="Add customer" busy={m.isPending} error={m.formError} onCancel={onDone} />
    </form>
  )
}

export function SubscriptionForm({ onDone }: FormProps) {
  const customers = useBilling('customers', (s) => s.listCustomers())
  const plans = useBilling('plans', (s) => s.listPlans())
  const planOptions = (plans.data?.data ?? []).filter((p) => p.status === 'active')
  const customerOptions = customers.data?.data ?? []
  const [customerId, setCustomerId] = useState('')
  const [planId, setPlanId] = useState('')
  const m = useMerchantMutation(merchant.subscriptions.create, 'Subscription created', onDone, true)

  if ((!customers.isPending && customerOptions.length === 0) || (!plans.isPending && planOptions.length === 0)) {
    return <p className="text-sm text-dim">You need at least one customer and one active plan before creating a subscription.</p>
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate({ customerId: customerId || customerOptions[0]?.id || '', planId: planId || planOptions[0]?.id || '' })
      }}
      className="space-y-4"
      noValidate
    >
      <SelectField label="Customer" value={customerId || customerOptions[0]?.id || ''} onChange={(e) => setCustomerId(e.target.value)} options={customerOptions.map((c) => ({ value: c.id, label: `${c.company} (${c.email})` }))} error={m.fields.customerId} />
      <SelectField label="Plan" value={planId || planOptions[0]?.id || ''} onChange={(e) => setPlanId(e.target.value)} options={planOptions.map((p) => ({ value: p.id, label: `${p.productName} / ${p.name} (${p.amount} USDC per ${p.interval})` }))} error={m.fields.planId} />
      <FormFooter
        label="Create subscription"
        busy={m.isPending}
        error={m.formError}
        onCancel={onDone}
        note="The subscription starts as incomplete. It becomes active only after the customer authorizes payment onchain, which is not available yet."
      />
    </form>
  )
}
