import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { handle, type Env, USDC } from '../src/service';
import { Fixture, settings, hash, paymentLog } from './fixtures';
const req = (path: string, body: unknown = {}) => new Request('https://private/v1/' + path, {
  method: 'POST',
  body: JSON.stringify(body)
});
const e = () => ({
  ...env,
  ...settings
}) as unknown as Env;
it('persists uint128 monetary values above signed 64-bit and JS safe integer without SQL casts',async()=>{const f=new Fixture(),b=e(),amount=(1n<<100n)+1n;f.logs=[paymentLog(hash('s'),hash('p'),amount)];expect((await handle(req('sync'),b,f.transport)).status).toBe(200);const row=await b.CHAIN_DB.prepare('SELECT body FROM events').first<{body:string}>();expect(JSON.parse(row!.body).args.amount).toBe(amount.toString())})
it.each([['foreign origin', {
  address: '0x9999999999999999999999999999999999999999'
}], ['USDC origin', {
  address: USDC
}], ['removed log', {
  removed: true
}], ['wrong block hash', {
  blockHash: hash('wrong')
}], ['out-of-range block', {
  blockNumber: '0x2'
}], ['invalid quantity', {
  logIndex: '0x00'
}], ['invalid ABI', {
  data: '0x1234'
}], ['unknown event', {
  topics: [hash('unknown')]
}]])('rejects %s without committing partial state', async (_name, override) => {
  const f = new Fixture(),
    b = e();
  f.logs = [{
    ...paymentLog(hash('s'), hash('p')),
    ...override
  }];
  expect((await handle(req('sync'), b, f.transport)).status).toBe(503);
  expect((await b.CHAIN_DB.prepare('SELECT cursor FROM runtime').first<{
    cursor: string | null;
  }>())?.cursor).toBeNull();
  expect((await b.CHAIN_DB.prepare('SELECT COUNT(*) n FROM events').first<{
    n: number;
  }>())?.n).toBe(0);
});
it('rejects receipt/log disagreement', async () => {
  const f = new Fixture(),
    b = e();
  f.logs = [paymentLog(hash('s'), hash('p'))];
  f.receiptLogs = [{
    ...f.logs[0],
    data: '0x'
  }];
  expect((await handle(req('sync'), b, f.transport)).status).toBe(503);
});
it('deduplicates duplicate provider logs without rewriting the append-only store', async () => {
  const f = new Fixture(),
    b = e(),
    log = paymentLog(hash('s'), hash('p'));
  f.logs = [log, log];
  f.receiptLogs = [log];
  const r = await handle(req('sync'), b, f.transport);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({
    processedEvents: 1,
    duplicateEvents: 1
  });
  expect((await b.CHAIN_DB.prepare('SELECT COUNT(*) n FROM events').first<{
    n: number;
  }>())?.n).toBe(1);
  await expect(b.CHAIN_DB.prepare("UPDATE events SET body='{}'").run()).rejects.toThrow('append only');
  await expect(b.CHAIN_DB.prepare('DELETE FROM events').run()).rejects.toThrow('append only');
  await expect(b.CHAIN_DB.prepare('INSERT OR REPLACE INTO events SELECT * FROM events').run()).rejects.toThrow('append only');
});
it('serializes concurrent sync attempts through the operational lease', async () => {
  const f = new Fixture(),
    b = e();
  f.logs = [paymentLog(hash('s'), hash('p'))];
  const results = await Promise.all([handle(req('sync'), b, f.transport), handle(req('sync'), b, f.transport)]);
  const bodies = await Promise.all(results.map(r => r.json() as Promise<{
    processedEvents: number;
    busy: boolean;
  }>));
  expect(bodies.filter(r => r.busy)).toHaveLength(1);
  expect(bodies.reduce((n, r) => n + r.processedEvents, 0)).toBe(1);
  expect((await b.CHAIN_DB.prepare('SELECT COUNT(*) n FROM events').first<{
    n: number;
  }>())?.n).toBe(1);
});
it('refuses a lost lease atomically and permits restart after expired lease', async () => {
  const f = new Fixture(),
    b = e();
  f.logs = [paymentLog(hash('s'), hash('p'))];
  let stolen = false;
  const transport: typeof fetch = async (input, init) => {
    const q = JSON.parse(String(init?.body));
    const r = await f.transport(input, init);
    if (q.method === 'eth_getLogs' && !stolen) {
      stolen = true;
      await b.CHAIN_DB.prepare("UPDATE runtime SET lease='new-owner',lease_until=?").bind(Date.now() + 60000).run();
    }
    return r;
  };
  expect((await handle(req('sync'), b, transport)).status).toBe(503);
  expect((await b.CHAIN_DB.prepare('SELECT cursor FROM runtime').first<{
    cursor: string | null;
  }>())?.cursor).toBeNull();
  expect((await b.CHAIN_DB.prepare('SELECT COUNT(*) n FROM events').first<{
    n: number;
  }>())?.n).toBe(0);
  await b.CHAIN_DB.prepare('UPDATE runtime SET lease_until=1').run();
  expect((await handle(req('sync'), b, f.transport)).status).toBe(200);
});
it('persists fail-stop on canonical mismatch even if RPC later returns the old fork', async () => {
  const f = new Fixture(),
    b = e();
  expect((await handle(req('sync'), b, f.transport)).status).toBe(200);
  f.badHash = true;
  expect((await handle(req('sync'), b, f.transport)).status).toBe(503);
  expect((await b.CHAIN_DB.prepare('SELECT halted FROM runtime').first<{
    halted: string;
  }>())?.halted).toBeTruthy();
  f.badHash = false;
  expect((await handle(req('sync'), b, f.transport)).status).toBe(503);
  expect((await handle(req('snapshot', {
    orgId: 'org'
  }), b, f.transport)).status).toBe(503);
});
it('persists fail-stop when a scanned log disagrees with its canonical block',async()=>{const f=new Fixture(),b=e();f.logs=[{...paymentLog(hash('s'),hash('p')),blockHash:hash('not-canonical')}];expect((await handle(req('sync'),b,f.transport)).status).toBe(503);expect((await b.CHAIN_DB.prepare('SELECT halted FROM runtime').first<{halted:string}>())?.halted).toBeTruthy();f.logs=[];expect((await handle(req('sync'),b,f.transport)).status).toBe(503)})
it('bounds scans to 32 blocks even when the RPC head is far ahead', async () => {
  const f = new Fixture(),
    b = e();
  f.head = '0x100000';
  const r = await handle(req('sync'), b, f.transport);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({
    cursor: {
      blockNumber: '32'
    }
  });
});
it.each([{
  APP_ENV: 'production'
}, {
  ARC_RPC_URL: 'https://evil.example/'
}, {
  ARC_RPC_URL: 'ftp://127.0.0.1/'
}, {
  ARC_RPC_URL: 'http://127.0.0.1:8545/?token=private'
}, {
  ARC_MANAGER_ADDRESS: 'broken'
}])('rejects unsafe configuration %j', async extra => {
  const f = new Fixture();
  expect((await handle(new Request('https://private/v1/config'), {
    ...e(),
    ...extra
  }, f.transport)).status).toBe(503);
  expect(f.calls).toEqual([]);
});
it('keeps empty tenant reads independent of 5001 unrelated global events', async () => {
  const f = new Fixture(),
    b = e();
  expect((await handle(req('sync'), b, f.transport)).status).toBe(200);
  await b.CHAIN_DB.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001) INSERT INTO events(id,block_number,body) SELECT 'cap-'||x,'1','{}' FROM n;");
  const r = await handle(req('snapshot', {
    orgId: 'org'
  }), b, f.transport);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ events: [], pagination: { complete: true, nextToken: null } });
});
it.each(['eth_chainId', 'eth_getCode', 'eth_call'])('fails closed on invalid %s verification', async method => {
  const f = new Fixture(),
    b = e();
  const transport: typeof fetch = async (input, init) => {
    const q = JSON.parse(String(init?.body));
    return q.method === method ? Response.json({
      result: q.method === 'eth_chainId' ? '0x1' : q.method === 'eth_getCode' ? '0x' : '0x' + '0'.repeat(64)
    }) : f.transport(input, init);
  };
  expect((await handle(new Request('https://private/v1/config'), b, transport)).status).toBe(503);
});
