import type { ChainBinding, ChainConfiguration, ChainProjection, ChainSnapshot, ChainValues, VerifiedChainEvent } from '../../shared/chain';
import { bindings, Invalid } from './bindings';
import { assertCanonical, cursorOf, halt, CapacityError, type RpcBlock } from './indexer';
import { historyPage, assertPageState, paymentProofs } from './history';
import { managerAbi, escrowAbi, Rpc, type Env } from './service';
const iso = (seconds: unknown): string | null => {
  const n = BigInt(String(seconds));
  return n === 0n ? null : new Date(Number(n * 1000n)).toISOString();
};
const normalize = (value: Record<string, unknown>): ChainValues => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'boolean' ? v : v === null ? null : typeof v === 'string' ? v.toLowerCase() : String(v)]));
const zero = '0x0000000000000000000000000000000000000000';

/** Account-owned proofs only: no organization allocation or payout ledger is inferred. */
export async function walletSnapshot(env: Env, c: ChainConfiguration, wallet: `0x${string}`, rpc: Rpc, token?: string): Promise<ChainSnapshot> {
  const empty: ChainSnapshot = { configuration: c, cursor: null, bindings: [], events: [], projections: [] };
  if (token && !c.configured) throw new Invalid('History snapshot deployment is unavailable');
  if (!c.configured) return empty;
  const cursor = cursorOf(await assertCanonical(env, c, rpc));
  if (token && !cursor) throw new Invalid('History snapshot cursor is unavailable');
  if (!cursor) return empty;
  const page = await historyPage(env, `wallet:${wallet}`, [], cursor, [{index:'events_account',field:'account',address:c.escrow!,value:wallet}], token);
  const events = page.events.filter(e => e.address === c.escrow && ['Withdrawn', 'PayoutAddressUpdated'].includes(e.name) && e.args.account === wallet);
  const projections: ChainProjection[] = events.map(e => ({
    orgId: `wallet:${wallet}`,
    kind: 'wallet',
    recordId: wallet,
    key: `0x${wallet.slice(2).padStart(64, '0')}`,
    state: 'updated',
    values: { ...e.args, eventId: e.id, eventName: e.name, transactionHash: e.transactionHash, timestamp: e.timestamp, createdAt: e.timestamp },
    blockNumber: e.blockNumber,
    transactionHash: e.transactionHash
  }));
  const block = '0x' + BigInt(cursor.blockNumber).toString(16);
  const recheck = await rpc.call<RpcBlock>('eth_getBlockByNumber', [block, false]);
  if (recheck.hash !== cursor.blockHash) return halt(env, 'Wallet snapshot block changed');
  await assertCanonical(env, c, rpc);
  await assertPageState(env, page, []);
  return { configuration: c, cursor, bindings: [], events, projections, pagination: page.pagination };
}
function matches(b: ChainBinding, e: VerifiedChainEvent, c: ChainConfiguration): boolean {
  const a = e.args;
  if (b.kind === 'plan') return e.address === c.manager && a.planKey === b.key && (a.merchant === undefined || a.merchant === b.merchant) && ['PlanCreated', 'PlanUpdated'].includes(e.name);
  if (b.kind === 'subscription') return e.address === c.manager && a.subKey === b.key && (a.customer === undefined || a.customer === b.customer) && (a.planKey === undefined || a.planKey === b.planKey) && (a.merchant === undefined || a.merchant === b.merchant);
  if (b.kind === 'escrow') return e.address === c.escrow && a.escrowKey === b.key && (a.customer === undefined || a.customer === b.customer) && (a.merchant === undefined || a.merchant === b.merchant);
  return e.address === c.manager && e.name === 'SubscriptionPaymentProcessed' && a.subKey === b.subscriptionKey && a.planKey === b.planKey && a.customer === b.customer && a.merchant === b.merchant && a.chargeNumber === b.chargeNumber && a.amount === b.amount;
}
export async function snapshot(env: Env, c: ChainConfiguration, orgId: string, rpc: Rpc, token?: string, selection?: { bound: ChainBinding[]; scope: string; recheck: () => Promise<ChainBinding[]> }): Promise<ChainSnapshot> {
  const bound = selection?.bound ?? await bindings(env, orgId);
  if (bound.length > 32) throw new CapacityError('Binding capacity exceeded; complete customer snapshot unavailable.');
  if (token && !c.configured) throw new Invalid('History snapshot deployment is unavailable');
  if (!c.configured) return {
    configuration: c,
    cursor: null,
    bindings: bound,
    events: [],
    projections: []
  };
  const r = await assertCanonical(env, c, rpc),
    cursor = cursorOf(r);
  if (token && !cursor) throw new Invalid('History snapshot cursor is unavailable');
  if (!cursor) return {
    configuration: c,
    cursor: null,
    bindings: bound,
    events: [],
    projections: []
  };
  const getters = new Set<string>();
  for (const b of bound) {
    if (b.kind === 'plan') getters.add('plan' + b.key);
    if (b.kind === 'subscription') {
      getters.add('subscription' + b.key); getters.add('mandate' + b.key); getters.add('plan' + b.planKey);
    }
    if (b.kind === 'escrow') {
      getters.add('escrow' + b.key); getters.add('balance' + b.key); getters.add('claimable' + b.key);
    }
  }
  // Reserve the pinned block read and both final canonical reads. No partial projections.
  if (getters.size + 3 > rpc.remaining) throw new CapacityError('Snapshot getter capacity exceeded; complete snapshot unavailable. Pagination is required before reporting totals.');
  const page = await historyPage(env, selection?.scope ?? `org:${orgId}`, bound, cursor, bound.map(b => ({
    index: b.kind === 'plan' ? 'events_plan' : b.kind === 'escrow' ? 'events_escrow' : 'events_subscription',
    field: b.kind === 'plan' ? 'planKey' : b.kind === 'escrow' ? 'escrowKey' : 'subKey',
    address: b.kind === 'escrow' ? c.escrow! : c.manager!, value: b.kind === 'invoice' || b.kind === 'payment' ? b.subscriptionKey! : b.key
  })), token);
  const events = page.events.filter(e => bound.some(b => matches(b, e, c)));
  const proofs = await paymentProofs(env, bound, c.manager!, cursor);
  const block = '0x' + BigInt(cursor.blockNumber).toString(16),
    projections: ChainProjection[] = [];
  const cache = new Map<string, Record<string, unknown>>();
  const get = async (kind: 'plan' | 'subscription' | 'mandate' | 'escrow', key: ChainBinding['key']) => {
    const id = kind + key;
    if (!cache.has(id)) {
      const value = (await rpc.read(kind === 'escrow' ? c.escrow! : c.manager!, kind === 'escrow' ? escrowAbi : managerAbi, kind === 'plan' ? 'getPlan' : kind === 'subscription' ? 'getSubscription' : kind === 'mandate' ? 'getMandate' : 'getEscrow', [key], block)) as Record<string, unknown>;
      cache.set(id, value);
    }
    return cache.get(id)!;
  };
  const pinned = await rpc.call<RpcBlock>('eth_getBlockByNumber', [block, false]);
  if (pinned.hash !== cursor.blockHash) return halt(env, 'Snapshot cursor mismatch');
  for (const b of bound) {
    const base = {
      orgId: b.orgId,
      kind: b.kind,
      recordId: b.recordId,
      key: b.key,
      blockNumber: cursor.blockNumber,
      transactionHash: null
    };
    if (b.kind === 'plan') {
      const p = await get('plan', b.key);
      if (p.merchant !== zero && String(p.merchant).toLowerCase() !== b.merchant) throw Error('Plan party mismatch');
      projections.push({
        ...base,
        state: p.merchant === zero ? 'pending' : p.active ? 'active' : 'inactive',
        values: {
          ...normalize(p),
          status: p.merchant === zero ? 'pending' : p.active ? 'active' : 'inactive'
        }
      });
    } else if (b.kind === 'subscription') {
      const s = await get('subscription', b.key),
        p = await get('plan', b.planKey!);
      if (Number(s.status) !== 0 && (String(s.customer).toLowerCase() !== b.customer || s.planKey !== b.planKey || String(p.merchant).toLowerCase() !== b.merchant)) throw Error('Subscription party mismatch');
      const state = ['pending', 'active', 'canceled'][Number(s.status)];
      if (!state) throw Error('Unknown subscription status');
      projections.push({
        ...base,
        state,
        values: {
          ...normalize(s),
          status: state,
          nextChargeAt: iso(s.nextChargeAt)
        }
      });
      const m = await get('mandate', b.key);
      const stateM = m.active ? BigInt(String(m.expiry)) <= BigInt(pinned.timestamp) ? 'expired' : 'active' : Number(m.nonce) === 0 ? 'missing' : 'revoked';
      projections.push({
        ...base,
        kind: 'mandate',
        state: stateM,
        values: {
          ...normalize(m),
          status: stateM,
          expiry: iso(m.expiry)
        }
      });
    } else if (b.kind === 'invoice' || b.kind === 'payment') {
      const matching = proofs.get(b.kind + ':' + b.recordId) ?? [];
      const paid = matching[0];
      if (matching.length > 1) throw Error('Multiple payment events for one charge');
      const state = paid ? 'paid' : 'pending';
      projections.push({
        ...base,
        state,
        transactionHash: paid?.transactionHash ?? null,
        values: {
          ...(paid?.args ?? {}),
          status: state,
          amount: b.amount!,
          chargeNumber: b.chargeNumber!,
          paidAt: paid?.timestamp ?? null,
          transactionHash: paid?.transactionHash ?? null,
          periodStart: paid ? iso(paid.args.periodStart) : null,
          nextChargeAt: paid ? iso(paid.args.nextChargeAt) : null
        }
      });
    } else {
      const e = await get('escrow', b.key);
      const exists = Number(e.status) !== 0;
      if (exists && (String(e.merchant).toLowerCase() !== b.merchant || String(e.customer).toLowerCase() !== b.customer || String(e.amount) !== b.amount)) throw Error('Escrow identity mismatch');
      const state = ['missing', 'pending', 'active', 'closed', 'cancelled'][Number(e.status)];
      if (!state) throw Error('Unknown escrow status');
      const dispute = ['none', 'open', 'resolved'][Number(e.dispute)],
        outcome = ['none', 'fully_vested', 'refunded', 'resolved', 'expired', 'settled'][Number(e.outcome)];
      if (!dispute || !outcome) throw Error('Unknown escrow state');
      const balance = await rpc.read(c.escrow!, escrowAbi, 'balanceOf', [b.key], block),
        claimable = await rpc.read(c.escrow!, escrowAbi, 'claimableAmount', [b.key], block);
      const values: ChainValues = {
        ...normalize(e),
        balance: String(balance),
        claimable: String(claimable),
        status: state,
        dispute,
        outcome,
        vestStart: iso(e.vestStart),
        vestEnd: BigInt(String(e.vestStart)) === 0n ? null : iso(BigInt(String(e.vestStart)) + BigInt(String(e.vestDuration))),
        disputedAt: iso(e.disputedAt),
        respondBy: BigInt(String(e.disputedAt)) === 0n ? null : iso(BigInt(String(e.disputedAt)) + BigInt(String(e.responseWindow))),
        resolveBy: BigInt(String(e.disputedAt)) === 0n ? null : iso(BigInt(String(e.disputedAt)) + BigInt(String(e.resolutionTimeout)))
      };
      projections.push({
        ...base,
        state,
        values
      });
      if (dispute !== 'none') projections.push({
        ...base,
        kind: 'dispute',
        state: dispute,
        values
      });
    }
  }
  const ledgerNames = ['SubscriptionPaymentProcessed', 'EscrowFunded', 'VestedClaimed', 'RefundCredited', 'DisputeResolved', 'DisputeExpired', 'SettlementAccepted'];
  for (const event of events.filter(e => ledgerNames.includes(e.name))) {
    const b = bound.find(b => matches(b, event, c));
    if (!b) continue;
    // RefundCredited is the sole customer refund source. Allocation events only add merchant awards.
    let kind: string, amount: string, direction: string;
    if (event.name === 'SubscriptionPaymentProcessed') {
      kind = 'payment';
      amount = String(event.args.amount);
      direction = 'in';
    } else if (event.name === 'EscrowFunded') {
      if (event.args.viaManager !== false) continue;
      kind = 'payment';
      amount = String(event.args.amount);
      direction = 'in';
    } else if (event.name === 'RefundCredited') {
      kind = 'refund';
      amount = String(event.args.amount);
      direction = 'out';
    } else if (event.name === 'VestedClaimed') {
      kind = 'claim';
      amount = String(event.args.amount);
      direction = 'in';
    } else {
      kind = 'award';
      amount = String(event.args.merchantAmount);
      direction = 'in';
    }
    if (BigInt(amount) === 0n) continue;
    projections.push({
      orgId: b.orgId,
      kind: 'ledger',
      recordId: event.id,
      key: b.key,
      state: kind === 'payment' ? 'paid' : 'credited',
      values: {
        ...event.args,
        eventName: event.name,
        kind,
        direction,
        amount,
        counterparty: b.customer ?? String(event.args.customer ?? ''),
        createdAt: event.timestamp,
        timestamp: event.timestamp,
        transactionHash: event.transactionHash
      },
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash
    });
  }
  // Never return a newer-state getter if the indexed block ceased to be canonical.
  const recheck = await rpc.call<RpcBlock>('eth_getBlockByNumber', [block, false]);
  if (recheck.hash !== cursor.blockHash) return halt(env, 'Snapshot block changed');
  await assertCanonical(env, c, rpc);
  await assertPageState(env, page, selection ? await selection.recheck() : await bindings(env, orgId));
  return {
    configuration: c,
    cursor,
    bindings: bound,
    events,
    projections,
    pagination: page.pagination
  };
}
