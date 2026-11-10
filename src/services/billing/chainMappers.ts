import type { ChainSnapshot, ChainValue, VerifiedChainEvent } from '@shared/chain'
import { formatBaseUnits } from '@shared/money'
import type { ApiEscrow, ApiInvoice, ApiPlan, ApiSubscription, DashboardOverview, Dispute, EscrowOverview, LedgerEntry } from '@shared/types'

export interface LiveBillingRecords {
  orgId: string
  plans: ApiPlan[]
  subscriptions: ApiSubscription[]
  invoices: ApiInvoice[]
  escrows: ApiEscrow[]
}

export function buildLiveEscrow(snapshot: ChainSnapshot, records: LiveBillingRecords): EscrowOverview {
  let held = 0n, claimable = 0n, frozen = 0n, pending = 0n
  const holds: EscrowOverview['holds'] = []
  const projections = snapshot.projections.filter(p => p.orgId === records.orgId && p.kind === 'escrow')
  for (const p of projections) {
    const row = records.escrows.find(r => r.id === p.recordId)
    const balance = units(p.values.balance), available = units(p.values.claimable)
    const disputed = p.values.dispute === 'open'
    const locked = disputed ? units(p.values.frozen) : 0n
    if (available + locked > balance) throw new Error('Invalid verified escrow allocation')
    held += balance; claimable += available; frozen += locked
    const unfunded = ['missing', 'pending'].includes(p.state)
    if (unfunded) pending += units(row?.amount ?? p.values.amount)
    const status = unfunded ? 'pending_funding' : disputed ? 'disputed' : p.state === 'active' ? 'funded' : p.values.outcome === 'refunded' ? 'refunded' : p.values.outcome === 'settled' ? 'settled' : 'released'
    holds.push({ id: p.recordId, customerName: row?.customerName ?? String(p.values.customer ?? 'Customer'), reference: row?.invoiceNumber ?? p.recordId, amount: formatBaseUnits(unfunded ? units(row?.amount ?? p.values.amount) : balance), status, releaseAt: typeof p.values.vestEnd === 'string' ? p.values.vestEnd : null })
  }
  for (const row of records.escrows) {
    if (projections.some(p => p.recordId === row.id)) continue
    if (row.status !== 'pending_funding') throw new Error('Funded escrow is missing verified snapshot state')
    pending += units(row.amount)
    holds.push({ id: row.id, customerName: row.customerName, reference: row.invoiceNumber, amount: formatBaseUnits(row.amount), status: 'pending_funding', releaseAt: null })
  }
  return { contractState: snapshot.configuration.configured ? 'deployed' : 'not_deployed', held: formatBaseUnits(held), pendingFunding: formatBaseUnits(pending), releasable: formatBaseUnits(claimable), disputed: formatBaseUnits(frozen), holds }
}

export function buildLiveDisputes(snapshot: ChainSnapshot, records: LiveBillingRecords): Dispute[] {
  return snapshot.projections.filter(p => p.orgId === records.orgId && p.kind === 'dispute').map(p => {
    const row = records.escrows.find(r => r.id === p.recordId)
    if (!['open', 'resolved'].includes(p.state)) throw new Error('Unknown verified dispute state')
    if (typeof p.values.merchantResponded !== 'boolean' || typeof p.values.disputedAt !== 'string' || typeof p.values.respondBy !== 'string') throw new Error('Incomplete verified dispute state')
    const opening = snapshot.events.find(event => event.name === 'DisputeOpened' && event.args.escrowKey === p.key)
    if (p.state === 'resolved' && !opening) throw new Error('Resolved dispute is missing its verified opening event')
    return { id: p.recordId, invoiceNumber: row?.invoiceNumber ?? p.recordId, customerName: row?.customerName ?? String(p.values.customer ?? 'Customer'), amount: formatBaseUnits(units(opening?.args.amount ?? p.values.frozen)), reason: 'Onchain dispute; evidence is committed by hash.', status: p.state === 'resolved' ? 'resolved' : p.values.merchantResponded ? 'under_review' : 'needs_response', openedAt: p.values.disputedAt, respondBy: p.values.respondBy }
  })
}

function units(value: ChainValue | undefined): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value)) throw new Error('Verified money must be an exact base-unit string')
  return BigInt(value)
}

function uniqueEvents(snapshot: ChainSnapshot): VerifiedChainEvent[] {
  const events = new Map<string, VerifiedChainEvent>()
  for (const event of snapshot.events) {
    const identity = `${event.chainId}:${event.transactionHash}:${event.logIndex}`
    if (!events.has(identity)) events.set(identity, event)
  }
  return [...events.values()]
}

/** Contract events have already been receipt-verified and tenant-filtered by the private Worker. */
export function buildLiveLedger(snapshot: ChainSnapshot, orgId: string): LedgerEntry[] {
  const events = uniqueEvents(snapshot)
  const entries: { row: LedgerEntry; block: bigint; transactionIndex: number; logIndex: number }[] = []
  const text = (value: ChainValue | undefined, fallback: string) => typeof value === 'string' ? value : fallback
  const push = (event: VerifiedChainEvent, kind: LedgerEntry['kind'], direction: LedgerEntry['direction'], amount: bigint, counterparty: string, identity?: string) => {
    if (amount === 0n) return
    entries.push({
      block: BigInt(event.blockNumber), transactionIndex: event.transactionIndex, logIndex: event.logIndex,
      row: { id: identity ?? `${event.chainId}:${event.transactionHash}:${event.logIndex}:${kind}`, kind, direction, amount: formatBaseUnits(amount), counterparty, status: 'succeeded', createdAt: event.timestamp, transactionHash: event.transactionHash, chainId: event.chainId },
    })
  }
  for (const event of events) {
    const args = event.args
    if (event.name === 'SubscriptionPaymentProcessed') push(event, 'payment', 'in', units(args.amount), text(args.customer, 'Customer'))
    else if (event.name === 'EscrowFunded') {
      if (typeof args.viaManager !== 'boolean') throw new Error('Verified escrow routing flag is missing')
      const amount = units(args.amount)
      if (!args.viaManager) push(event, 'payment', 'in', amount, text(args.payer, 'Customer'))
      push(event, 'escrow_hold', 'out', amount, text(args.payer, 'Escrow contract'))
    } else if (event.name === 'VestedClaimed') push(event, 'escrow_release', 'in', units(args.amount), text(args.merchant, 'Merchant credit'))
    else if (event.name === 'RefundCredited') push(event, 'refund', 'out', units(args.amount), text(args.customer, 'Customer refund credit'))
    else if (['DisputeResolved', 'DisputeExpired', 'SettlementAccepted'].includes(event.name)) push(event, 'escrow_release', 'in', units(args.merchantAmount), text(args.merchant, 'Merchant award credit'))
  }
  // Withdrawn is wallet-wide. Only a tenant-scoped, independently attributed projection
  // may turn it into an organization payout; never duplicate the entire wallet amount.
  for (const projection of snapshot.projections) {
    if (projection.orgId !== orgId || projection.kind !== 'ledger' || projection.values.kind !== 'payout') continue
    if (!['succeeded', 'confirmed'].includes(projection.state)) throw new Error('Unconfirmed ledger projection')
    const source = events.find(event => event.name === 'Withdrawn' && event.transactionHash === projection.transactionHash)
    if (!source) throw new Error('Scoped payout has no canonical withdrawal proof')
    push(source, 'payout', 'out', units(projection.values.amount), text(projection.values.counterparty, text(source.args.to, 'Payout wallet')), projection.recordId)
  }
  entries.sort((a, b) => a.block === b.block ? b.transactionIndex - a.transactionIndex || b.logIndex - a.logIndex : a.block > b.block ? -1 : 1)
  const seen = new Set<string>()
  return entries.filter(entry => !seen.has(entry.row.id) && Boolean(seen.add(entry.row.id))).map(entry => entry.row)
}

export function buildLiveOverview(snapshot: ChainSnapshot, records: LiveBillingRecords, now = new Date()): DashboardOverview {
  const months = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + index, 1))
    return { key: date.toISOString().slice(0, 7), label: date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }), value: 0, baseUnits: '0' }
  })
  let gross = 0n
  for (const event of uniqueEvents(snapshot)) {
    if (event.name !== 'SubscriptionPaymentProcessed' && !(event.name === 'EscrowFunded' && event.args.viaManager === false)) continue
    const amount = units(event.args.amount)
    gross += amount
    const date = new Date(event.timestamp)
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid verified event timestamp')
    const point = months.find(month => month.key === date.toISOString().slice(0, 7))
    if (point) point.baseUnits = (BigInt(point.baseUnits) + amount).toString()
  }
  const maximum = months.reduce((max, point) => BigInt(point.baseUnits) > max ? BigInt(point.baseUnits) : max, 0n)
  // Only a bounded dimensionless pixel ratio becomes a number; all monetary values stay exact.
  for (const point of months) point.value = maximum === 0n ? 0 : Number(BigInt(point.baseUnits) * 900n / maximum)
  const active = records.subscriptions.filter(subscription => subscription.status === 'active')
  const pending = records.invoices.filter(invoice => invoice.status === 'open')
  let monthly = 0n
  const mix = new Map<string, number>()
  for (const subscription of active) {
    const amount = units(subscription.amount)
    // SaaS run-rate convention: 52 weeks or one annual price spread over 12 months.
    monthly += subscription.interval === 'week' ? amount * 52n / 12n : subscription.interval === 'year' ? amount / 12n : amount
    mix.set(subscription.planName, (mix.get(subscription.planName) ?? 0) + 1)
  }
  let outstanding = 0n
  for (const invoice of pending) {
    const total = units(invoice.total)
    const paid = units(invoice.amountPaid)
    if (paid > total) throw new Error('Invoice paid amount exceeds its verified total')
    outstanding += total - paid
  }
  return {
    totalRevenue: formatBaseUnits(gross), totalRevenueDelta: 0, mrr: formatBaseUnits(monthly), mrrDelta: 0,
    activeSubscriptions: active.length, activeSubscriptionsDelta: 0, pendingInvoices: pending.length,
    pendingInvoicesAmount: formatBaseUnits(outstanding), escrowBalance: buildLiveEscrow(snapshot, records).held, revenueSeries: months,
    // No synthetic historical MRR trail or growth percentages are claimed by the live UI.
    mrrSparkline: [], activity: [],
    planMix: [...mix].map(([label, value]) => ({ label, value })), recent: buildLiveLedger(snapshot, records.orgId).slice(0, 6),
  }
}
