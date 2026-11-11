import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { CapacityError } from '../src/indexer';
import { handle, Rpc, OversizedRpcResponseError, type Env } from '../src/service';
import { Fixture, settings, hash, paymentLog } from './fixtures';
const request = () => new Request('https://private/v1/sync', { method: 'POST', body: '{}' });
const environment = () => ({ ...env, ...settings }) as unknown as Env;
function oversized(cancel: () => void) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(524289)); },
    cancel
  }));
}
it('distinguishes and cancels byte overflow, without confusing shared-budget exhaustion', async () => {
  let canceled = 0;
  const rpc = new Rpc(settings.ARC_RPC_URL, async () => oversized(() => { canceled++; }));
  await expect(rpc.call('eth_getLogs', [])).rejects.toBeInstanceOf(OversizedRpcResponseError);
  expect(canceled).toBe(1);
  expect(rpc.remaining).toBe(41);
  const budget = new Rpc(settings.ARC_RPC_URL, async () => { throw Error('must not fetch'); }, { calls: 42 });
  await expect(budget.call('eth_getLogs', [])).rejects.toBeInstanceOf(CapacityError);
});
it('refuses a single oversized block explicitly, canceling each bounded prefix and committing nothing', async () => {
  const e = environment(), f = new Fixture(); f.head = '0x1000';
  let canceled = 0; const ranges: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const q = JSON.parse(String(init?.body));
    if (q.method === 'eth_getLogs') { ranges.push(q.params[0].toBlock); return oversized(() => { canceled++; }); }
    return f.transport(input, init);
  };
  const response = await handle(request(), e, transport);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('Single block response capacity exceeded') });
  expect(ranges).toEqual(['0x100', '0x80', '0x40', '0x20', '0x10', '0x8', '0x4', '0x2', '0x1']);
  expect(canceled).toBe(9);
  expect(Number(response.headers.get('x-chain-rpc-calls'))).toBe(22);
  expect(await e.CHAIN_DB.prepare('SELECT cursor,halted,lease FROM runtime').first()).toMatchObject({cursor:null,halted:null,lease:null});
  expect(await e.CHAIN_DB.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(0);
});
it.each(['transport', 'generic-capacity', 'invalid-json', 'receipt-overflow', 'identity-overflow'])('does not shrink or swallow %s failures', async kind => {
  const e = environment(), f = new Fixture(); f.head = '0x20'; f.logs = [paymentLog(hash('s'), hash('p'))];
  let logCalls = 0, canceled = 0;
  const transport: typeof fetch = async (input, init) => {
    const q = JSON.parse(String(init?.body));
    if (kind === 'identity-overflow' && q.method === 'eth_chainId') return oversized(() => { canceled++; });
    if (q.method === 'eth_getLogs') {
      logCalls++;
      if (kind === 'transport') throw Error('network unavailable');
      if (kind === 'generic-capacity') throw new CapacityError('unrelated quota exhausted');
      if (kind === 'invalid-json') return new Response('{');
    }
    if (kind === 'receipt-overflow' && q.method === 'eth_getTransactionReceipt') return oversized(() => { canceled++; });
    return f.transport(input, init);
  };
  const response = await handle(request(), e, transport);
  expect(response.status).toBe(503);
  expect(logCalls).toBe(kind === 'identity-overflow' ? 0 : 1);
  expect(canceled).toBe(kind.endsWith('overflow') ? 1 : 0);
  expect(await e.CHAIN_DB.prepare('SELECT cursor,halted FROM runtime').first()).toMatchObject({cursor:null,halted:null});
  expect(await e.CHAIN_DB.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(0);
});
