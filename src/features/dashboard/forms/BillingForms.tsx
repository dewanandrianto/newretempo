import { useState, type FormEvent } from 'react'
import { useBilling } from '@/hooks/useBilling'
import { merchant } from '@/services/merchant/api'
import { newIdempotencyKey } from '@/services/api/client'
import { SelectField, TextField } from '@/components/ui/Field'
import { useMerchantMutation } from '../actions'
import { FormFooter } from './shared'
import { invoiceDraftInput, matchingSubscriptions } from './invoiceDraft'

interface FormProps {
  onDone: () => void
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

export function InvoiceForm({ onDone }: FormProps) {
  const customers = useBilling('customers', (s) => s.listCustomers())
  const options = customers.data?.data ?? []
  const subscriptions = useBilling('subscriptions', (s) => s.listSubscriptions())
  const [subscriptionId, setSubscriptionId] = useState('')
  // One key per opened dialog: a retry after a network error can never create a second invoice.
  const [key] = useState(newIdempotencyKey)
  const [customerId, setCustomerId] = useState('')
  const [description, setDescription] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [price, setPrice] = useState('')
  const [dueDate, setDueDate] = useState(inDays(14))
  const [memo, setMemo] = useState('')
  const [localError, setLocalError] = useState<string>()
  const m = useMerchantMutation((body: Parameters<typeof merchant.invoices.create>[0]) => merchant.invoices.create(body, key), 'Draft invoice created', onDone, true)

  const selectedCustomerId = customerId || options[0]?.id || ''
  const matching = matchingSubscriptions(subscriptions.data?.data ?? [], selectedCustomerId)
  const subscription = matching.find((s) => s.id === subscriptionId)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    try {
      const body = invoiceDraftInput({ customerId: selectedCustomerId, subscriptionId, description, quantity, price, dueDate, memo }, subscriptions.data?.data ?? [])
      setLocalError(undefined)
      m.mutate(body)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Check the invoice details.')
    }
  }

  if (!customers.isPending && options.length === 0) return <p className="text-sm text-dim">Add a customer before creating an invoice.</p>
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <SelectField label="Customer" value={selectedCustomerId} onChange={(e) => { setCustomerId(e.target.value); setSubscriptionId(''); setLocalError(undefined) }} options={options.map((c) => ({ value: c.id, label: `${c.company} (${c.email})` }))} error={m.fields.customerId} />
      <SelectField label="Subscription (optional)" value={subscriptionId} onChange={(e) => { setSubscriptionId(e.target.value); setLocalError(undefined) }} disabled={subscriptions.isPending || subscriptions.isError} options={[{ value: '', label: 'Standalone invoice' }, ...matching.map((s) => ({ value: s.id, label: `${s.planName} · ${s.amount} USDC · ${s.id}` }))]} error={m.fields.subscriptionId ?? (subscriptions.isError ? 'Subscriptions could not be loaded. Retry before creating a renewal invoice.' : undefined)} hint="Select a subscription to create its next billing-period invoice." />
      {subscription && <TextField label="Billing period start (UTC)" value={subscription.currentPeriodEnd} readOnly error={m.fields.periodStart} hint="Exact next charge time from the subscription. This billing-period identity cannot be edited." />}
      <TextField label="Line item" value={description} onChange={(e) => setDescription(e.target.value)} error={m.fields['lineItems.0.description'] ?? m.fields.lineItems} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Quantity" inputMode="numeric" value={subscription ? '1' : quantity} readOnly={Boolean(subscription)} onChange={(e) => setQuantity(e.target.value)} error={m.fields['lineItems.0.quantity']} />
        <TextField label="Unit price (USDC)" inputMode="decimal" placeholder="99.00" value={subscription?.amount ?? price} readOnly={Boolean(subscription)} onChange={(e) => setPrice(e.target.value)} error={m.fields['lineItems.0.unitAmount']} hint={subscription ? 'Immutable subscription price; one fixed-price charge per period.' : undefined} />
      </div>
      <TextField label="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} error={m.fields.dueAt} />
      <TextField label="Memo (optional)" value={memo} onChange={(e) => setMemo(e.target.value)} error={m.fields.memo} />
      <FormFooter label="Create draft" busy={m.isPending} error={localError ?? m.formError} onCancel={onDone} note={subscription ? 'Create this draft, then open the invoice and select Finalize. Use Checkout link on that invoice for the next subscription payment.' : 'Drafts can be edited. Finalize the invoice to open it for payment.'} />
    </form>
  )
}

function useOpenInvoices() {
  const invoices = useBilling('invoices', (s) => s.listInvoices())
  return { query: invoices, open: (invoices.data?.data ?? []).filter((i) => i.status === 'open') }
}

export function PaymentForm({ onDone }: FormProps) {
  const { query, open } = useOpenInvoices()
  const [key] = useState(newIdempotencyKey)
  const [invoiceId, setInvoiceId] = useState('')
  const m = useMerchantMutation((id: string) => merchant.payments.create(id, key), 'Payment record created', onDone, true)

  if (!query.isPending && open.length === 0) return <p className="text-sm text-dim">There are no open invoices. Finalize a draft invoice first.</p>
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate(invoiceId || open[0]?.id || '')
      }}
      className="space-y-4"
      noValidate
    >
      <SelectField label="Open invoice" value={invoiceId || open[0]?.id || ''} onChange={(e) => setInvoiceId(e.target.value)} options={open.map((i) => ({ value: i.id, label: `${i.number} · ${i.customerName} · ${i.amount} USDC` }))} error={m.fields.invoiceId} />
      <FormFooter
        label="Create payment record"
        busy={m.isPending}
        error={m.formError}
        onCancel={onDone}
        note="This records a pending payment for the full amount due. No USDC moves, and it cannot be marked paid here. Only a verified onchain transaction can do that."
      />
    </form>
  )
}

export function EscrowForm({ onDone }: FormProps) {
  const { query, open } = useOpenInvoices()
  const [key] = useState(newIdempotencyKey)
  const [invoiceId, setInvoiceId] = useState('')
  const [days, setDays] = useState('7')
  const m = useMerchantMutation((v: { invoiceId: string; releaseAfterDays: number }) => merchant.escrows.create(v, key), 'Escrow record created', onDone, true)

  if (!query.isPending && open.length === 0) return <p className="text-sm text-dim">There are no open invoices. Finalize a draft invoice first.</p>
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate({ invoiceId: invoiceId || open[0]?.id || '', releaseAfterDays: Number(days) || 0 })
      }}
      className="space-y-4"
      noValidate
    >
      <SelectField label="Open invoice" value={invoiceId || open[0]?.id || ''} onChange={(e) => setInvoiceId(e.target.value)} options={open.map((i) => ({ value: i.id, label: `${i.number} · ${i.customerName} · ${i.amount} USDC` }))} error={m.fields.invoiceId} />
      <TextField label="Release window (days)" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} error={m.fields.releaseAfterDays} hint="How long funds would be held after they are funded onchain." />
      <FormFooter
        label="Create escrow record"
        busy={m.isPending}
        error={m.formError}
        onCancel={onDone}
        note="The record starts as pending funding. Funding, release and refund can only happen through verified blockchain events, which are not live yet."
      />
    </form>
  )
}
