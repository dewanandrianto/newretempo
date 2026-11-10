import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { handle, Rpc, type Env } from '../src/service';
import { actorKey, reference, chargeReference } from '../src/bindings';
import { Fixture, settings, hash, paymentLog, merchant, customer } from './fixtures';
const request = (route: string, body: unknown = {}) => new Request('https://private/v1/' + route, { method: 'POST', body: JSON.stringify(body) });
const environment = () => ({ ...env, ...settings }) as unknown as Env;
it.each([['escrow',7],['payment',30]] as const)('enforces the %s admission boundary without losing previous identities',async(kind,accepted)=>{
 const e=environment(),f=new Fixture(),orgId='quota-'+kind;
 const planKey=actorKey(merchant,reference(orgId,'plan','p')),subKey=actorKey(customer,reference(orgId,'subscription','s'));
 for(const b of [{orgId,kind:'plan',recordId:'p',key:planKey,merchant},{orgId,kind:'subscription',recordId:'s',key:subKey,planKey,merchant,customer}])expect((await handle(request('bind',b),e,f.transport)).status).toBe(200);
 for(let i=1;i<=accepted+1;i++){
  const ref=chargeReference(subKey,String(i)),key=kind==='escrow'?actorKey(merchant,ref):ref;
  const response=await handle(request('bind',{orgId,kind,recordId:'charge'+i,key,planKey,subscriptionKey:subKey,merchant,customer,amount:'1',chargeNumber:String(i)}),e,f.transport);
  expect(response.status).toBe(i<=accepted?200:503);
 }
 expect(await e.CHAIN_DB.prepare('SELECT COUNT(*) AS n FROM bindings WHERE org_id=?').bind(orgId).first()).toMatchObject({n:accepted+2});
 expect(await e.CHAIN_DB.prepare('SELECT COUNT(*) AS n FROM key_owners WHERE org_id=?').bind(orgId).first()).toMatchObject({n:accepted+2});
 console.info(JSON.stringify({fixture:'admission-'+kind,acceptedBindings:accepted+2,acceptedChargeBindings:accepted,rejectedNext:true}));
});

it('atomically refuses capacity admission before concurrent new bindings can break existing reads',async()=>{
 const e=environment(),f=new Fixture(),orgId='admission';
 const binding=(i:number)=>({orgId,kind:'plan',recordId:'p'+i,key:actorKey(merchant,reference(orgId,'plan','p'+i)),merchant});
 for(let i=0;i<25;i++)expect((await handle(request('bind',binding(i)),e,f.transport)).status).toBe(200);
 const responses=await Promise.all([handle(request('bind',binding(25)),e,f.transport),handle(request('bind',binding(26)),e,f.transport)]);
 expect(responses.map(r=>r.status).sort()).toEqual([200,503]);
 expect(await (responses.find(r=>r.status===503)!).json()).toMatchObject({error:expect.stringContaining('Binding capacity exceeded')});
 expect(await e.CHAIN_DB.prepare('SELECT COUNT(*) AS n FROM bindings WHERE org_id=?').bind(orgId).first()).toMatchObject({n:26});
 expect((await handle(request('bind',binding(0)),e,f.transport)).status).toBe(200);
 expect((await handle(request('sync'),e,f.transport)).status).toBe(200);
 f.getters.getPlan={merchant,payout:merchant,amount:1n,interval:2592000,trial:0,grace:0,vestDuration:0,arbitrator:merchant,customerMayRefundUnvested:false,active:true};
 expect((await handle(request('snapshot',{orgId}),e,f.transport)).status).toBe(200);
});
it('never commits the verified prefix of a block when its last receipt is invalid',async()=>{
 const e=environment(),f=new Fixture();
 f.logs=Array.from({length:16},(_,i)=>({...paymentLog(hash('s'),hash('p')),transactionHash:hash('atomic'+i),logIndex:'0x'+i.toString(16)}));
 const transport:typeof fetch=async(input,init)=>{const q=JSON.parse(String(init?.body));f.badReceipt=q.method==='eth_getTransactionReceipt'&&q.params[0]===f.logs[15].transactionHash;return f.transport(input,init)};
 const response=await handle(request('sync'),e,transport);
 expect(response.status).toBe(503);expect(f.calls.filter(m=>m==='eth_getTransactionReceipt')).toHaveLength(16);
 expect(await e.CHAIN_DB.prepare('SELECT cursor,halted,lease FROM runtime').first()).toMatchObject({cursor:null,halted:null,lease:null});
 expect(await e.CHAIN_DB.prepare('SELECT COUNT(*) AS n FROM events').first()).toMatchObject({n:0});
});
it('keeps outgoing RPC concurrency below six while consuming every response',async()=>{
 const e=environment(),f=new Fixture();let active=0,peak=0;
 const transport:typeof fetch=async(input,init)=>{active++;peak=Math.max(peak,active);try{await new Promise(resolve=>setTimeout(resolve,1));return await f.transport(input,init)}finally{active--}};
 const response=await handle(request('sync'),e,transport);expect(response.status).toBe(200);expect(peak).toBe(3);expect(active).toBe(0);
 console.info(JSON.stringify({fixture:'empty-sync',rpcCalls:f.calls.length,peakRpcConnections:peak}));
});
it('bounds RPC response bytes without trusting Content-Length and refuses redirect chains',async()=>{
 const transport:typeof fetch=async (_input,init)=>{expect(init?.redirect).toBe('manual');return new Response(' '.repeat(524289));};
 await expect(new Rpc(settings.ARC_RPC_URL,transport).call('eth_chainId',[])).rejects.toThrow('RPC response capacity exceeded');
});
it('does not read or parse unrelated global history for an empty tenant',async()=>{
 const e=environment(),f=new Fixture();expect((await handle(request('sync'),e,f.transport)).status).toBe(200);
 await e.CHAIN_DB.batch(Array.from({length:257},(_,i)=>e.CHAIN_DB.prepare('INSERT INTO events(id,block_number,body) VALUES(?,?,?)').bind('history'+i,'1','{}')));
 const response=await handle(request('snapshot',{orgId:'history'}),e,f.transport);
 expect(response.status).toBe(200);expect(await response.json()).toMatchObject({events:[],projections:[],pagination:{complete:true,nextToken:null}});
});
it.each([26,27])('preflights %i unique plan getters against the whole request budget',async count=>{
 const e=environment(),f=new Fixture();
 expect((await handle(request('sync'),e,f.transport)).status).toBe(200);
 // Simulate a pre-migration over-capacity tenant, never production admission.
 if(count===27)await e.CHAIN_DB.prepare('DROP TRIGGER bindings_capacity').run();
 await e.CHAIN_DB.batch(Array.from({length:count},(_,i)=>{const identity={orgId:'getters',kind:'plan',recordId:'p'+i,key:hash('p'+i),merchant};return e.CHAIN_DB.prepare('INSERT INTO bindings(org_id,kind,record_id,binding_key,identity) VALUES(?,?,?,?,?)').bind('getters','plan','p'+i,identity.key,JSON.stringify(identity))}));
 f.getters.getPlan={merchant,payout:merchant,amount:1n,interval:2592000,trial:0,grace:0,vestDuration:0,arbitrator:merchant,customerMayRefundUnvested:false,active:true};
 f.calls=[];
 const response=await handle(request('snapshot',{orgId:'getters'}),e,f.transport);
 expect(response.status).toBe(count===26?200:503);
 if(count===27){expect(await response.json()).toMatchObject({error:expect.stringContaining('Snapshot getter capacity exceeded')});expect(f.calls.length).toBe(11);}
 else {expect((await response.json() as {projections:unknown[]}).projections).toHaveLength(26);expect(f.calls.length).toBe(40);}
});
it('refuses oversized binding collections instead of returning a truncated snapshot', async()=>{
 const e=environment(),f=new Fixture();
 // Pre-migration fixture: demonstrate explicit unavailability for an existing oversized tenant.
 await e.CHAIN_DB.prepare('DROP TRIGGER bindings_capacity').run();
 await e.CHAIN_DB.batch(Array.from({length:33},(_,i)=>{const identity={orgId:'large',kind:'plan',recordId:'p'+i,key:hash('p'+i),merchant};return e.CHAIN_DB.prepare('INSERT INTO bindings(org_id,kind,record_id,binding_key,identity) VALUES(?,?,?,?,?)').bind('large','plan','p'+i,identity.key,JSON.stringify(identity))}));
 const response=await handle(request('snapshot',{orgId:'large'}),e,f.transport);
 expect(response.status).toBe(503);
 expect(await response.json()).toMatchObject({error:expect.stringContaining('Binding capacity exceeded')});
});
it('batches existing-event reads and counts actual D1 invocations independently of statement count', async () => {
  const f = new Fixture(), e = environment(), db=e.CHAIN_DB;
  let invocations=0;
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){
    if(key==='bind') return (...values:unknown[])=>wrap(target.bind(...values));
    if(['first','all','run','raw'].includes(String(key))) return (...args:unknown[])=>{invocations++;return Reflect.get(target,key).apply(target,args)};
    return Reflect.get(target,key);
  }});
  e.CHAIN_DB=new Proxy(db,{get(target,key){
    if(key==='prepare') return (sql:string)=>wrap(target.prepare(sql));
    if(key==='batch') return (statements:D1PreparedStatement[])=>{invocations++;return target.batch(statements)};
    return Reflect.get(target,key);
  }});
  f.logs=Array.from({length:16},(_,i)=>({...paymentLog(hash('s'),hash('p')),logIndex:'0x'+i.toString(16)}));
  const response=await handle(request('sync'),e,f.transport);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({processedEvents:16});
  expect(f.calls.filter(m=>m==='eth_getTransactionReceipt')).toHaveLength(1);
  expect(invocations).toBe(6);
  expect(f.calls.length).toBe(16);
  expect(invocations+f.calls.length).toBeLessThanOrEqual(50);
  console.info(JSON.stringify({fixture:'sixteen-events-one-transaction',d1Invocations:invocations,rpcCalls:f.calls.length,combinedInvocations:invocations+f.calls.length}));
});
it('fits sparse event blocks into a request budget by scanning a smaller complete prefix', async () => {
  const f = new Fixture(), e = environment(); f.head = '0x20';
  const logs = Array.from({length:16}, (_, i) => ({ ...paymentLog(hash('s'),hash('p')), blockNumber:'0x'+(i+1).toString(16), blockHash:hash('0x'+(i+1).toString(16)), transactionHash:hash('sparse'+i), logIndex:'0x0' }));
  const transport: typeof fetch = async (input, init) => {
    const q = JSON.parse(String(init?.body));
    if(q.method === 'eth_getLogs') { f.calls.push(q.method); return Response.json({ result: logs.filter(l => BigInt(l.blockNumber) <= BigInt(q.params[0].toBlock)) }); }
    if(q.method === 'eth_getTransactionReceipt') { f.calls.push(q.method); const log=logs.find(l=>l.transactionHash===q.params[0])!; return Response.json({result:{status:'0x1',transactionHash:log.transactionHash,blockHash:log.blockHash,blockNumber:log.blockNumber,transactionIndex:'0x0',logs:[log]}}); }
    return f.transport(input,init);
  };
  const response=await handle(request('sync'),e,transport);
  expect(response.status).toBe(200);
  const body=await response.json() as {cursor:{blockNumber:string};processedEvents:number};
  expect(BigInt(body.cursor.blockNumber)).toBeGreaterThan(0n);
  expect(BigInt(body.cursor.blockNumber)).toBeLessThan(32n);
  expect(body.processedEvents).toBe(Number(body.cursor.blockNumber));
  expect(body.cursor.blockNumber).toBe('8');
  expect(f.calls.length).toBe(39);
  expect(f.calls.length).toBeLessThanOrEqual(40);
  expect(Number(response.headers.get('x-chain-rpc-calls'))).toBe(f.calls.length);
  console.info(JSON.stringify({fixture:'sparse-sixteen-event-blocks',rpcCalls:f.calls.length,cursor:body.cursor.blockNumber,processedEvents:body.processedEvents}));
});
it('caps RPC calls before transport and exposes whole-request configuration counts', async () => {
  const f = new Fixture(), rpc = new Rpc(settings.ARC_RPC_URL, f.transport);
  for (let i = 0; i < 40; i++) await rpc.call('eth_chainId', []);
  await expect(rpc.call('eth_chainId', [])).rejects.toThrow('RPC request budget exceeded');
  expect(f.calls).toHaveLength(40);
  const response = await handle(new Request('https://private/v1/config'), environment(), f.transport);
  expect(response.headers.get('x-chain-rpc-calls')).toBe('10');
});
it('shrinks dense ranges to a fully verified prefix and later refuses the impossible next block', async () => {
  const f = new Fixture(), e = environment(); f.head = '0x20';
  const logs = Array.from({ length: 17 }, (_, i) => ({ ...paymentLog(hash('s'), hash('p')), blockNumber: '0x2', blockHash: hash('0x2'), transactionHash: hash('dense' + i), logIndex: '0x' + i.toString(16) }));
  const ranges: string[][] = [];
  const transport: typeof fetch = async (input, init) => {
    const q = JSON.parse(String(init?.body));
    if (q.method === 'eth_getLogs') { const range = q.params[0]; ranges.push([range.fromBlock, range.toBlock]); return Response.json({ result: BigInt(range.toBlock) >= 2n ? logs : [] }); }
    return f.transport(input, init);
  };
  const response = await handle(request('sync'), e, transport);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ cursor: { blockNumber: '1' }, processedEvents: 0 });
  expect(ranges).toHaveLength(6);
  const retry = await handle(request('sync'), e, transport);
  expect(retry.status).toBe(503);
  expect(await retry.json()).toMatchObject({ error: expect.stringContaining('Single block capacity exceeded') });
  expect(JSON.parse((await e.CHAIN_DB.prepare('SELECT cursor FROM runtime').first<{cursor:string}>())!.cursor).blockNumber).toBe('1');
});
it('gates a single block with too many distinct events before fetching any receipts', async () => {
  const f = new Fixture(), e = environment();
  f.logs = Array.from({ length: 17 }, (_, i) => ({ ...paymentLog(hash('s'), hash('p')), transactionHash: hash('tx' + i), logIndex: '0x' + i.toString(16) }));
  const response = await handle(request('sync'), e, f.transport);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('Single block capacity exceeded') });
  expect(f.calls.filter(m => m === 'eth_getTransactionReceipt')).toHaveLength(0);
  expect(await e.CHAIN_DB.prepare('SELECT cursor FROM runtime').first()).toMatchObject({ cursor: null });
  expect(await e.CHAIN_DB.prepare('SELECT COUNT(*) AS n FROM events').first()).toMatchObject({ n: 0 });
});
