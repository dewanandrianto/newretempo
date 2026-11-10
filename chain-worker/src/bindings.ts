import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
import type { ChainBinding } from '../../shared/chain';
import { address, hash, uint, type Env } from './service';
import { CapacityError } from './indexer';
export class Invalid extends Error {}
export function reference(orgId: string, kind: string, id: string): Hex {
  return keccak256(toHex(JSON.stringify(['retempo:v1', orgId, kind, id])));
}
export function actorKey(actor: Hex, ref: Hex): Hex {
  return keccak256(encodeAbiParameters([{
    type: 'address'
  }, {
    type: 'bytes32'
  }], [actor, ref]));
}
export function chargeReference(sub: Hex, charge: string): Hex {
  return keccak256(encodeAbiParameters([{
    type: 'bytes32'
  }, {
    type: 'uint256'
  }], [sub, BigInt(charge)]));
}
export function validateBinding(input: unknown): ChainBinding {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Invalid('Invalid binding');
  const b = input as ChainBinding;
  const fields = ['orgId', 'kind', 'recordId', 'key', 'merchant', 'customer', 'planKey', 'subscriptionKey', 'chargeNumber', 'amount', 'metadata'];
  if (Object.keys(b).some(k => !fields.includes(k)) || ![b.orgId, b.recordId].every(x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(x)) || !['plan', 'subscription', 'invoice', 'payment', 'escrow'].includes(b.kind) || !hash.test(b.key) || !address.test(b.merchant) || /^0x0{40}$/i.test(b.merchant)) throw new Invalid('Invalid binding');
  if (b.customer !== undefined && (!address.test(b.customer) || /^0x0{40}$/i.test(b.customer))) throw new Invalid('Invalid customer');
  if (b.amount !== undefined && (typeof b.amount !== 'string' || !uint.test(b.amount) || BigInt(b.amount) > (1n << 128n) - 1n)) throw new Invalid('Invalid amount');
  for (const k of [b.planKey, b.subscriptionKey]) if (k !== undefined && !hash.test(k)) throw new Invalid('Invalid key');
  if (b.metadata !== undefined && (!b.metadata || typeof b.metadata !== 'object' || Array.isArray(b.metadata) || Object.values(b.metadata).some(v => v !== null && !['string', 'boolean'].includes(typeof v)))) throw new Invalid('Invalid metadata');
  const normalized = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, ['key', 'merchant', 'customer', 'planKey', 'subscriptionKey'].includes(k) && typeof v === 'string' ? v.toLowerCase() : v])) as unknown as ChainBinding;
  let expected: Hex;
  if (b.kind === 'plan') expected = actorKey(normalized.merchant, reference(b.orgId, 'plan', b.recordId));else if (b.kind === 'subscription') {
    if (!normalized.customer || !normalized.planKey) throw new Invalid('Missing subscription parties');
    expected = actorKey(normalized.customer, reference(b.orgId, 'subscription', b.recordId));
  } else {
    if (!normalized.subscriptionKey || !normalized.planKey || !normalized.customer || typeof b.chargeNumber !== 'string' || !uint.test(b.chargeNumber) || BigInt(b.chargeNumber) < 1n || BigInt(b.chargeNumber) > 4294967295n || !b.amount) throw new Invalid('Missing charge identity');
    const ref = chargeReference(normalized.subscriptionKey, b.chargeNumber);
    expected = b.kind === 'escrow' ? actorKey(normalized.merchant, ref) : ref;
  }
  if (normalized.key !== expected) throw new Invalid('Server-derived key mismatch');
  return normalized;
}
function stable(binding: ChainBinding): string {
  return JSON.stringify(Object.fromEntries(Object.entries(binding).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, k === 'metadata' && v ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v])));
}
export async function bind(env: Env, input: unknown): Promise<ChainBinding> {
  const b = validateBinding(input),
    identity = stable(b),
    db = env.CHAIN_DB;
  const existing = await db.prepare('SELECT identity FROM bindings WHERE org_id=? AND kind=? AND record_id=?').bind(b.orgId, b.kind, b.recordId).first<{
    identity: string;
  }>();
  if (existing) {
    if (existing.identity !== identity) throw new Invalid('Binding identity is immutable');
    return JSON.parse(existing.identity);
  }
  const linked = await db.prepare('SELECT identity FROM bindings WHERE org_id=? AND binding_key=? AND kind=?').bind(b.orgId, b.planKey ?? '', 'plan').first<{
    identity: string;
  }>();
  if (b.kind !== 'plan' && (!linked || JSON.parse(linked.identity).merchant !== b.merchant)) throw new Invalid('Plan binding is required');
  if (!['plan', 'subscription'].includes(b.kind)) {
    const sub = await db.prepare("SELECT identity FROM bindings WHERE org_id=? AND binding_key=? AND kind='subscription'").bind(b.orgId, b.subscriptionKey).first<{
      identity: string;
    }>();
    if (!sub) throw new Invalid('Subscription binding is required');
    const s = JSON.parse(sub.identity) as ChainBinding;
    if (s.customer !== b.customer || s.merchant !== b.merchant || s.planKey !== b.planKey) throw new Invalid('Subscription parties mismatch');
  }
  const owner = await db.prepare('SELECT * FROM key_owners WHERE binding_key=?').bind(b.key).first<{
    org_id: string;
    merchant: string;
    customer: string | null;
  }>();
  if (owner && (owner.org_id !== b.orgId || owner.merchant !== b.merchant || owner.customer !== (b.customer ?? null))) throw new Invalid('Key ownership conflict');
  try {
    await db.batch([db.prepare('INSERT INTO key_owners(binding_key,org_id,merchant,customer) VALUES(?,?,?,?) ON CONFLICT(binding_key) DO UPDATE SET binding_key=CASE WHEN org_id=excluded.org_id AND merchant=excluded.merchant AND customer IS excluded.customer THEN binding_key ELSE NULL END').bind(b.key, b.orgId, b.merchant, b.customer ?? null), db.prepare('INSERT INTO bindings(org_id,kind,record_id,binding_key,identity) VALUES(?,?,?,?,?)').bind(b.orgId, b.kind, b.recordId, b.key, identity)]);
  } catch (error) {
    if (String(error).includes('Binding capacity exceeded')) throw new CapacityError('Binding capacity exceeded; admission refused to preserve complete snapshots for existing records.');
    throw new Invalid('Binding conflict');
  }
  return b;
}
export async function bindings(env: Env, orgId: string): Promise<ChainBinding[]> {
  const rows = await env.CHAIN_DB.prepare('SELECT identity FROM bindings WHERE org_id=? ORDER BY kind,record_id LIMIT 33').bind(orgId).all<{
    identity: string;
  }>();
  if (rows.results.length > 32) throw new CapacityError('Binding capacity exceeded; complete snapshot unavailable. Pagination is required before reporting totals.');
  return rows.results.map(r => JSON.parse(r.identity) as ChainBinding);
}
