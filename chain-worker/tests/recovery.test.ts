import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { handle, type Env } from '../src/service';
import { actorKey, reference, chargeReference, validateBinding } from '../src/bindings';
import { Fixture, settings, merchant, customer, hash } from './fixtures';

const req = (path: string, body: unknown) => new Request('https://private/v1/' + path, {
  method: 'POST', body: JSON.stringify(body)
});

it.each([{ amount: 1000000 }, { chargeNumber: 2 }, { metadata: 'paid' }, { metadata: ['paid'] }])('rejects noncanonical binding wire values %j', invalid => {
  const orgId = 'wire-org';
  const planKey = actorKey(merchant, reference(orgId, 'plan', 'plan'));
  const subscriptionKey = actorKey(customer, reference(orgId, 'subscription', 'sub'));
  expect(() => validateBinding({ orgId, kind: 'invoice', recordId: 'invoice', key: chargeReference(subscriptionKey, '2'), subscriptionKey, planKey, merchant, customer, chargeNumber: '2', amount: '1000000', ...invalid })).toThrow();
});

it('does not bind one verified charge to multiple invoice or payment records', async () => {
  const f = new Fixture(), e = { ...env, ...settings } as unknown as Env;
  const orgId = 'recovery-org';
  const planKey = actorKey(merchant, reference(orgId, 'plan', 'plan'));
  const subscriptionKey = actorKey(customer, reference(orgId, 'subscription', 'sub'));
  for (const binding of [
    { orgId, kind: 'plan', recordId: 'plan', key: planKey, merchant },
    { orgId, kind: 'subscription', recordId: 'sub', key: subscriptionKey, planKey, merchant, customer }
  ]) expect((await handle(req('bind', binding), e, f.transport)).status).toBe(200);
  for (const kind of ['invoice', 'payment']) {
    const binding = { orgId, kind, recordId: kind, key: chargeReference(subscriptionKey, '1'), subscriptionKey, planKey, merchant, customer, chargeNumber: '1', amount: '1000000' };
    expect((await handle(req('bind', binding), e, f.transport)).status).toBe(200);
    expect((await handle(req('bind', binding), e, f.transport)).status).toBe(200);
    expect((await handle(req('bind', { ...binding, recordId: kind + '-duplicate' }), e, f.transport)).status).toBe(400);
  }
  const rows = await e.CHAIN_DB.prepare('SELECT kind,record_id FROM bindings').all();
  expect(rows.results).toHaveLength(4);
});

it.each([false, true])('pins state getters and rechecks canonical hash (changed=%s)', async changed => {
  const f = new Fixture(), e = { ...env, ...settings } as unknown as Env;
  const orgId = 'pinned-org', key = actorKey(merchant, reference(orgId, 'plan', 'plan'));
  f.getters.getPlan = { merchant, payout: merchant, amount: 9007199254740993n, interval: 2592000, trial: 0, grace: 0, vestDuration: 0, arbitrator: merchant, customerMayRefundUnvested: false, active: true };
  expect((await handle(req('bind', { orgId, kind: 'plan', recordId: 'plan', key, merchant }), e, f.transport)).status).toBe(200);
  expect((await handle(req('sync', {}), e, f.transport)).status).toBe(200);
  const getterBlocks: unknown[] = [];
  let readState = false;
  const transport: typeof fetch = async (input, init) => {
    const q = JSON.parse(String(init?.body));
    if (q.method === 'eth_call' && q.params[0].data.length > 10) {
      getterBlocks.push(q.params[1]);
      readState = true;
    }
    if (changed && readState && q.method === 'eth_getBlockByNumber' && q.params[0] === '0x1') {
      return Response.json({ result: { number: '0x1', hash: hash('changed'), timestamp: '0x6553f100' } });
    }
    return f.transport(input, init);
  };
  const response = await handle(req('snapshot', { orgId }), e, transport);
  expect(getterBlocks).toEqual(['0x1']);
  expect(response.status).toBe(changed ? 503 : 200);
  if (changed) expect((await e.CHAIN_DB.prepare('SELECT halted FROM runtime').first<{ halted: string }>())?.halted).toBe('Snapshot block changed');
  else {
    const snapshot = await response.json() as { projections: { values: Record<string, unknown> }[] };
    expect(snapshot.projections[0].values.amount).toBe('9007199254740993');
    expect(Object.values(snapshot.projections[0].values).every(v => v === null || ['string', 'boolean'].includes(typeof v))).toBe(true);
  }
});
