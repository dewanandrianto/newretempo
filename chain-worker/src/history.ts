import { keccak256, toHex } from 'viem';
import type { ChainBinding, ChainCursor, ChainSnapshot, VerifiedChainEvent } from '../../shared/chain';
import type { Env } from './service';
import { Invalid } from './bindings';
import { CapacityError, runtime } from './indexer';

export const PAGE_SIZE = 64;
interface PageState { snapshot_id: string; scope: string; binding_hash: string; cursor: string; high_water: number; after_row: number; expires: number }
export interface HistoryPage { state: PageState; events: VerifiedChainEvent[]; pagination: NonNullable<ChainSnapshot['pagination']> }
const bindingHash = (bound: ChainBinding[]) => keccak256(toHex(JSON.stringify(bound)));
export function pageToken(body: Record<string, unknown>): string | undefined {
  if (body.pageToken === undefined) return undefined;
  if (typeof body.pageToken !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.pageToken)) throw new Invalid('Invalid history page token');
  return body.pageToken;
}
export async function assertPageState(env: Env, page: HistoryPage, bound: ChainBinding[]): Promise<void> {
  const current = await runtime(env);
  if (current.halted || current.cursor !== page.state.cursor || bindingHash(bound) !== page.state.binding_hash || page.state.expires <= Date.now()) throw new CapacityError('History snapshot changed or expired; restart complete pagination.');
}
/** Every index arm reads at most 65 candidates, including irrelevant event types.
 * Filtering happens AFTER keyset selection so irrelevant rows cannot create an unbounded scan.
 * rowid is an internal append-only sequence, not a client-controlled chain authority.
 */
export async function historyPage(env: Env, scope: string, bound: ChainBinding[], cursor: ChainCursor, selectors: { index: string; field: string; address: string; value: string }[], token?: string): Promise<HistoryPage> {
  const cursorText = JSON.stringify(cursor), digest = bindingHash(bound);
  let state: PageState;
  if (token) {
    const stored = await env.CHAIN_DB.prepare('SELECT snapshot_id,scope,binding_hash,cursor,high_water,after_row,expires FROM history_pages WHERE token=?').bind(token).first<PageState>();
    if (!stored || stored.scope !== scope || stored.binding_hash !== digest || stored.cursor !== cursorText || stored.expires <= Date.now()) throw new Invalid('History page token is invalid, expired, or snapshot changed');
    state = stored;
  } else {
    const high = await env.CHAIN_DB.prepare('SELECT MAX(rowid) AS n FROM events').first<{ n: number | null }>();
    state = { snapshot_id: keccak256(toHex(JSON.stringify([scope,digest,cursorText,high?.n ?? 0]))), scope, binding_hash: digest, cursor: cursorText, high_water: high?.n ?? 0, after_row: 0, expires: Date.now() + 300000 };
  }
  const unique = [...new Map(selectors.map(s => [JSON.stringify(s), s])).values()];
  if (unique.length > 32) throw new CapacityError('History selector capacity exceeded');
  const rows = unique.length ? await env.CHAIN_DB.batch<{ sequence: number; body: string }>(unique.map(s => {
    // All identifiers originate from fixed server literals, never request fields.
    if (!['events_plan','events_subscription','events_escrow','events_account'].includes(s.index) || !['planKey','subKey','escrowKey','account'].includes(s.field)) throw Error('Invalid selector');
    return env.CHAIN_DB.prepare(`SELECT rowid AS sequence,body FROM events INDEXED BY ${s.index} WHERE json_extract(body,'$.address')=? AND json_extract(body,'$.args.${s.field}')=? ${s.index==='events_plan'?"AND json_extract(body,'$.name') IN ('PlanCreated','PlanUpdated')":''} AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 65`).bind(s.address, s.value, state.after_row, state.high_water);
  })) : [];
  const candidates = [...new Map(rows.flatMap(r => r.results).map(row => [row.sequence, row])).values()].sort((a,b) => a.sequence - b.sequence);
  const selected = candidates.slice(0, PAGE_SIZE);
  const more = candidates.length > PAGE_SIZE;
  let nextToken: string | null = null;
  if (more) {
    nextToken = crypto.randomUUID();
    await env.CHAIN_DB.batch([
      env.CHAIN_DB.prepare('DELETE FROM history_pages WHERE token IN (SELECT token FROM history_pages WHERE expires<=? LIMIT 64)').bind(Date.now()),
      env.CHAIN_DB.prepare('INSERT INTO history_pages(token,snapshot_id,scope,binding_hash,cursor,high_water,after_row,expires) VALUES(?,?,?,?,?,?,?,?)').bind(nextToken, state.snapshot_id, scope, digest, cursorText, state.high_water, selected.at(-1)!.sequence, state.expires)
    ]);
  }
  const events = selected.map(row => JSON.parse(row.body) as VerifiedChainEvent).filter(e => BigInt(e.blockNumber) <= BigInt(cursor.blockNumber));
  return { state, events, pagination: { snapshotId: state.snapshot_id, nextToken, complete: !more, after: state.after_row, through: selected.at(-1)?.sequence ?? state.after_row, highWater: state.high_water } };
}
/** Indexed exact payment proof lookup is independent of the event-history page. */
export async function paymentProofs(env: Env, bound: ChainBinding[], manager: string, cursor: ChainCursor): Promise<Map<string, VerifiedChainEvent[]>> {
  const charges = bound.filter(b => b.kind === 'invoice' || b.kind === 'payment');
  if (!charges.length) return new Map();
  const rows = await env.CHAIN_DB.batch<{ body: string }>(charges.map(b => env.CHAIN_DB.prepare("SELECT body FROM events INDEXED BY events_payment WHERE json_extract(body,'$.address')=? AND json_extract(body,'$.args.subKey')=? AND json_extract(body,'$.args.chargeNumber')=? AND json_extract(body,'$.args.planKey')=? AND json_extract(body,'$.args.customer')=? AND json_extract(body,'$.args.merchant')=? AND json_extract(body,'$.args.amount')=? AND json_extract(body,'$.name')='SubscriptionPaymentProcessed' LIMIT 2").bind(manager,b.subscriptionKey!,b.chargeNumber!,b.planKey!,b.customer!,b.merchant,b.amount!)));
  return new Map(charges.map((b,i) => [b.kind + ':' + b.recordId, rows[i].results.map(r => JSON.parse(r.body) as VerifiedChainEvent).filter(e => BigInt(e.blockNumber) <= BigInt(cursor.blockNumber))]));
}
