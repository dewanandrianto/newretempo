import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, type Abi } from 'viem';
import { handle, type Env } from '../src/service';
import { Fixture, settings, hash, merchant, customer, escrow, escrowAbi } from './fixtures';
import type { ChainSnapshot } from '../../shared/chain';
const req = (route: string, body: unknown) => new Request('https://private/v1/' + route, { method: 'POST', body: JSON.stringify(body) });
const e = () => ({ ...env, ...settings }) as unknown as Env;

it('returns only canonical account-owned wallet proofs, without tenant bindings or ledger attribution', async () => {
  const f = new Fixture(), b = e();
  const event = (name: string, args: Record<string, unknown>, i: number) => {
    const abi = escrowAbi as Abi, def = abi.find(d => d.type === 'event' && d.name === name)!;
    if (def.type !== 'event') throw Error('fixture ABI');
    const fields = def.inputs.filter(d => !d.indexed);
    return { address: escrow, blockNumber: '0x1', blockHash: hash('0x1'), transactionHash: hash('wallet-tx'), transactionIndex: '0x0', logIndex: '0x' + i.toString(16), removed: false, topics: encodeEventTopics({ abi, eventName: name, args }), data: encodeAbiParameters(fields, fields.map(d => args[d.name!])) };
  };
  f.logs = [
    event('Withdrawn', { account: customer, to: merchant, amount: 9007199254740993n }, 0),
    event('PayoutAddressUpdated', { account: customer, newPayout: merchant, nonce: 1n }, 1),
    event('Withdrawn', { account: merchant, to: customer, amount: 1n }, 2)
  ];
  expect((await handle(req('sync', {}), b, f.transport)).status).toBe(200);
  const response = await handle(req('wallet-snapshot', { wallet: customer.toUpperCase().replace('0X', '0x') }), b, f.transport);
  expect(response.status).toBe(200);
  const s = await response.json() as ChainSnapshot;
  expect(s.bindings).toEqual([]);
  expect(s.events).toHaveLength(2);
  expect(s.projections).toHaveLength(2);
  expect(s.events.every(event => event.args.account === customer)).toBe(true);
  for (const [i, p] of s.projections.entries()) {
    expect(p).toMatchObject({ kind: 'wallet', orgId: 'wallet:' + customer, recordId: customer, key: '0x' + customer.slice(2).padStart(64, '0'), state: 'updated', transactionHash: s.events[i].transactionHash, blockNumber: '1', values: { ...s.events[i].args, eventName: s.events[i].name, timestamp: s.events[i].timestamp } });
  }
  const replay = await handle(req('wallet-snapshot', { wallet: customer }), b, f.transport);
  expect(await replay.json()).toEqual(s);
  const other = await (await handle(req('wallet-snapshot', { wallet: '0x9999999999999999999999999999999999999999' }), b, f.transport)).json() as ChainSnapshot;
  expect(other.events).toEqual([]);
  expect(other.projections).toEqual([]);
  f.badHash = true;
  expect((await handle(req('wallet-snapshot', { wallet: customer }), b, f.transport)).status).toBe(503);
  f.badHash = false;
  expect((await handle(req('wallet-snapshot', { wallet: customer }), b, f.transport)).status).toBe(503);
});

it.each([{}, { wallet: 'broken' }, { wallet: [customer] }, { wallet: customer, orgId: 'forged' }, { wallet: customer, status: 'paid' }])('rejects malformed wallet snapshot input %j', async body => {
  expect((await handle(req('wallet-snapshot', body), e(), new Fixture().transport)).status).toBe(400);
});

it('keeps wallet reads independent of 5001 unrelated global events', async () => {
  const f = new Fixture(), b = e();
  expect((await handle(req('sync', {}), b, f.transport)).status).toBe(200);
  await b.CHAIN_DB.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001) INSERT INTO events(id,block_number,body) SELECT 'cap-'||x,'1','{}' FROM n;");
  const r = await handle(req('wallet-snapshot', { wallet: customer }), b, f.transport);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ events: [], pagination: { complete: true, nextToken: null } });
});
