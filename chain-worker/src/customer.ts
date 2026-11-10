import { keccak256, toHex } from 'viem';
import type { ChainBinding, ChainConfiguration, ChainSnapshot } from '../../shared/chain';
import { Invalid } from './bindings';
import { snapshot } from './projections';
import { address, type Env, type Rpc } from './service';
import { CapacityError } from './indexer';
import { pageToken } from './history';
/** Trusted service-binding scope, derived afresh from public SIWE ownership on EVERY page. */
export async function customerSnapshot(env: Env, configuration: ChainConfiguration, input: unknown, rpc: Rpc): Promise<ChainSnapshot> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Invalid('Invalid customer snapshot request');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(k => !['orgIds','wallets','pageToken'].includes(k)) || !Array.isArray(body.orgIds) || body.orgIds.length > 20 || !body.orgIds.every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v)) || !Array.isArray(body.wallets) || body.wallets.length < 1 || body.wallets.length > 32 || !body.wallets.every(v => typeof v === 'string' && address.test(v))) throw new Invalid('Invalid customer snapshot scope');
  const orgIds = [...new Set(body.orgIds as string[])].sort(), wallets = [...new Set((body.wallets as string[]).map(v => v.toLowerCase()))].sort();
  const load = async (): Promise<ChainBinding[]> => {
    if (!orgIds.length) return [];
    const rows = await env.CHAIN_DB.prepare(`SELECT identity FROM bindings WHERE org_id IN (${orgIds.map(() => '?').join(',')}) ORDER BY org_id,kind,record_id LIMIT 641`).bind(...orgIds).all<{identity:string}>();
    if (rows.results.length > 640) throw new CapacityError('Customer binding capacity exceeded');
    const all = rows.results.map(r => JSON.parse(r.identity) as ChainBinding);
    const owned = all.filter(b => b.customer && wallets.includes(b.customer));
    const plans = new Set(owned.map(b => b.orgId + ':' + b.planKey));
    return all.filter(b => owned.includes(b) || b.kind === 'plan' && plans.has(b.orgId + ':' + b.key));
  };
  return snapshot(env, configuration, '', rpc, pageToken(body), { bound: await load(), scope: 'customer:' + keccak256(toHex(JSON.stringify([orgIds,wallets]))), recheck: load });
}
