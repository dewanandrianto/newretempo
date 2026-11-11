import { useState } from 'react'
import { Ban, CheckCircle2, Trash2, XCircle } from 'lucide-react'
import type { Dispute, Invoice, LedgerEntry, Payment } from '@shared/types'
import { useBilling } from '@/hooks/useBilling'
import { fmtDate, fmtUsdc, titleCase } from '@/lib/format'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import type { Column } from '@/components/ui/DataTable'
import { Notice } from '@/components/ui/States'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { merchant } from '@/services/merchant/api'
import { CheckoutLinkAction } from '@/features/onchain/MerchantActions'
import { ROLE_REASON, useCan } from '@/features/auth/permissions'
import { ConfirmAction, CreateDialog, useMerchantMutation } from '../actions'
import { InvoiceForm, PaymentForm } from '../forms/BillingForms'
import { ListPage } from '../ListPage'

const invoiceColumns: Column<Invoice>[] = [
  {
    key: 'number',
    header: 'Invoice',
    render: (i) => (
      <div>
        <p className="num font-medium text-fg">{i.number}</p>
        <p className="text-xs text-faint">{i.customerName}</p>
      </div>
    ),
  },
  { key: 'issued', header: 'Issued', hideOnMobile: true, render: (i) => fmtDate(i.issuedAt) },
  { key: 'due', header: 'Due', hideOnMobile: true, render: (i) => fmtDate(i.dueAt) },
  { key: 'amount', header: 'Amount', align: 'right', render: (i) => <span className="text-fg">{fmtUsdc(i.amount)} USDC</span> },
  { key: 'status', header: 'Status', render: (i) => <StatusBadge status={i.status} /> },
]

function InvoiceDetail({ invoice, onClose }: { invoice: Invoice | null; onClose: () => void }) {
  const can = useCan('invoices')
  const finalize = useMerchantMutation(() => merchant.invoices.finalize(invoice?.id ?? ''), 'Invoice finalized', onClose)
  const voidIt = useMerchantMutation(() => merchant.invoices.void(invoice?.id ?? ''), 'Invoice voided', onClose)
  const remove = useMerchantMutation(() => merchant.invoices.remove(invoice?.id ?? ''), 'Draft deleted', onClose)
  return (
    <Modal open={invoice !== null} onClose={onClose} title={invoice?.number ?? 'Invoice'} description={invoice ? `${invoice.customerName} · due ${fmtDate(invoice.dueAt)}` : undefined}>
      {invoice && (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <StatusBadge status={invoice.status} />
            <p className="display num text-2xl font-semibold text-fg">
              {fmtUsdc(invoice.amount)} <span className="text-sm font-medium text-faint">USDC</span>
            </p>
          </div>
          <ul className="divide-y divide-line/60 rounded-xl border border-line text-sm">
            {invoice.lineItems.map((l) => (
              <li key={l.description} className="flex justify-between gap-4 px-4 py-3">
                <span className="text-fg">
                  {l.description} <span className="text-faint">x {l.quantity}</span>
                </span>
                <span className="num text-dim">{fmtUsdc(l.unitAmount)}</span>
              </li>
            ))}
          </ul>
          {invoice.status === 'open' && (invoice.subscriptionId ? <CheckoutLinkAction subscriptionId={invoice.subscriptionId} invoiceId={invoice.id} /> : <p className="text-xs text-faint">This standalone invoice has no supported onchain checkout. Create a subscription-backed invoice to collect payment; a manual record is not settlement.</p>)}
          {can && (
            <div className="flex flex-wrap justify-end gap-2">
              {invoice.status === 'draft' && (
                <>
                  <Button variant="danger" size="sm" icon={<Trash2 className="size-4" />} loading={remove.isPending} onClick={() => remove.mutate(undefined)}>
                    Delete draft
                  </Button>
                  <Button size="sm" icon={<CheckCircle2 className="size-4" />} loading={finalize.isPending} onClick={() => finalize.mutate(undefined)}>
                    Finalize
                  </Button>
                </>
              )}
              {(invoice.status === 'draft' || invoice.status === 'open') && (
                <Button variant="secondary" size="sm" icon={<Ban className="size-4" />} loading={voidIt.isPending} onClick={() => voidIt.mutate(undefined)}>
                  Void invoice
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

export function InvoicesPage() {
  const query = useBilling('invoices', (s) => s.listInvoices())
  const can = useCan('invoices')
  const [selected, setSelected] = useState<Invoice | null>(null)
  return (
    <>
      <ListPage
        title="Invoices"
        description="Create drafts, finalize them to open for payment, or void them. Select a row for details."
        query={query}
        columns={invoiceColumns}
        rowKey={(i) => i.id}
        actions={
          <CreateDialog label="New invoice" title="New invoice" description="Creates a draft you can still edit." disabled={!can} disabledReason={ROLE_REASON}>
            {(close) => <InvoiceForm onDone={close} />}
          </CreateDialog>
        }
        onRowClick={setSelected}
        empty={{ title: 'No invoices yet', description: 'Use New invoice to bill a customer in USDC.' }}
        filters={[
          { value: 'draft', label: 'Draft', match: (i) => i.status === 'draft' },
          { value: 'open', label: 'Open', match: (i) => i.status === 'open' },
          { value: 'paid', label: 'Paid', match: (i) => i.status === 'paid' },
          { value: 'void', label: 'Void', match: (i) => i.status === 'void' },
        ]}
      />
      <InvoiceDetail invoice={selected} onClose={() => setSelected(null)} />
    </>
  )
}

const paymentColumns: Column<Payment>[] = [
  {
    key: 'id',
    header: 'Payment',
    render: (p) => (
      <div>
        <p className="num font-medium text-fg">{p.id}</p>
        <p className="text-xs text-faint">{p.customerName}</p>
      </div>
    ),
  },
  { key: 'invoice', header: 'Invoice', hideOnMobile: true, render: (p) => <span className="num">{p.invoiceNumber}</span> },
  { key: 'date', header: 'Date', hideOnMobile: true, render: (p) => fmtDate(p.createdAt) },
  { key: 'amount', header: 'Amount', align: 'right', render: (p) => <span className="text-fg">{fmtUsdc(p.amount)} USDC</span> },
  { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
]

function PaymentActions({ payment }: { payment: Payment }) {
  const can = useCan('payments')
  const cancel = useMerchantMutation(() => merchant.payments.cancel(payment.id), 'Payment record canceled')
  if (!can || payment.status !== 'pending') return null
  return (
    <ConfirmAction
      label="Cancel"
      icon={<XCircle className="size-4" />}
      title="Cancel this payment record?"
      description="The invoice stays open and a new payment record can be created."
      confirmLabel="Cancel record"
      onConfirm={() => cancel.mutateAsync(undefined)}
    />
  )
}

const paymentActionColumn: Column<Payment> = { key: 'actions', header: '', align: 'right', render: (p) => <PaymentActions payment={p} /> }

export function PaymentsPage() {
  const query = useBilling('payments', (s) => s.listPayments())
  const can = useCan('payments')
  return (
    <ListPage
      title="Payments"
      description="Payment records for open invoices. Success is recorded only from verified onchain transactions."
      query={query}
      columns={[...paymentColumns, paymentActionColumn]}
      rowKey={(p) => p.id}
      actions={
        <CreateDialog label="New payment record" title="New payment record" disabled={!can} disabledReason={ROLE_REASON}>
          {(close) => <PaymentForm onDone={close} />}
        </CreateDialog>
      }
      empty={{ title: 'No payment records yet', description: 'Finalize an invoice, then use New payment record to track its payment.' }}
      filters={[
        { value: 'pending', label: 'Pending', match: (p) => p.status === 'pending' || p.status === 'processing' },
        { value: 'succeeded', label: 'Succeeded', match: (p) => p.status === 'succeeded' },
        { value: 'closed', label: 'Failed or canceled', match: (p) => p.status === 'failed' || p.status === 'canceled' },
      ]}
      footer={
        <Notice title="Verified settlement" className="mt-4">
          Payment records remain pending until a successful payment transaction is independently verified. Creating a record does not move funds.
        </Notice>
      }
    />
  )
}

const ledgerColumns: Column<LedgerEntry>[] = [
  {
    key: 'type',
    header: 'Type',
    render: (t) => (
      <div>
        <p className="font-medium text-fg">{titleCase(t.kind)}</p>
        <p className="num text-xs text-faint">{t.id}</p>
      </div>
    ),
  },
  { key: 'party', header: 'Counterparty', hideOnMobile: true, render: (t) => t.counterparty },
  { key: 'date', header: 'Date', hideOnMobile: true, render: (t) => fmtDate(t.createdAt) },
  {
    key: 'amount',
    header: 'Amount',
    align: 'right',
    render: (t) => (
      <span className={t.direction === 'in' ? 'text-positive' : 'text-fg'}>
        {t.direction === 'in' ? '+' : '-'}
        {fmtUsdc(t.amount)} USDC
      </span>
    ),
  },
  { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
]

export function TransactionsPage() {
  const query = useBilling('transactions', (s) => s.listTransactions())
  return (
    <ListPage
      title="Transactions"
      description="A unified ledger of payments, escrow movements, refunds and payouts."
      query={query}
      columns={ledgerColumns}
      rowKey={(t) => t.id}
      empty={{ title: 'No transactions yet', description: 'Ledger entries are recorded as money moves.' }}
      filters={[
        { value: 'in', label: 'Incoming', match: (t) => t.direction === 'in' },
        { value: 'out', label: 'Outgoing', match: (t) => t.direction === 'out' },
      ]}
      footer={
        <Notice title="Verified ledger" className="mt-4">
          Only verified chain events appear here. Claims and refund credits are allocations, not wallet withdrawals. Wallet-wide withdrawals are excluded unless independently attributed to this organization.
        </Notice>
      }
    />
  )
}

const disputeColumns: Column<Dispute>[] = [
  {
    key: 'id',
    header: 'Dispute',
    render: (d) => (
      <div>
        <p className="font-medium text-fg">{d.customerName}</p>
        <p className="num text-xs text-faint">
          {d.id} · {d.invoiceNumber}
        </p>
      </div>
    ),
  },
  { key: 'reason', header: 'Reason', hideOnMobile: true, render: (d) => d.reason },
  { key: 'respond', header: 'Respond by', hideOnMobile: true, render: (d) => fmtDate(d.respondBy) },
  { key: 'amount', header: 'Amount', align: 'right', render: (d) => <span className="text-fg">{fmtUsdc(d.amount)} USDC</span> },
  {
    key: 'status',
    header: 'Status',
    render: (d) =>
      d.status === 'needs_response' ? <Badge tone="negative">Needs response</Badge> : <StatusBadge status={d.status} />,
  },
]

export function DisputesPage() {
  const query = useBilling('disputes', (s) => s.listDisputes())
  return (
    <ListPage
      title="Disputes"
      description="Customer disputes against invoices held in escrow."
      query={query}
      columns={disputeColumns}
      rowKey={(d) => d.id}
      empty={{ title: 'No disputes', description: 'When a customer disputes a payment it will be listed here with a response deadline.' }}
      filters={[
        { value: 'open', label: 'Open', match: (d) => d.status !== 'resolved' },
        { value: 'resolved', label: 'Resolved', match: (d) => d.status === 'resolved' },
      ]}
    />
  )
}
