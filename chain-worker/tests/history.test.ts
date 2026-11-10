import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { handle, type Env } from '../src/service';
import { Fixture, settings, hash, escrow, customer } from './fixtures';
import type { ChainSnapshot, VerifiedChainEvent } from '../../shared/chain';
import { actorKey, reference, chargeReference } from '../src/bindings';
import { collectChainPages } from '../../shared/chainPages';
import { merchant } from './fixtures';
const request = (body: unknown) => new Request('https://private/v1/wallet-snapshot', { method: 'POST', body: JSON.stringify(body) });
const environment = () => ({ ...env, ...settings }) as unknown as Env;
async function seed(e: Env, count: number, wallet = customer) {
  await e.CHAIN_DB.batch(Array.from({ length: count }, (_, i) => {
    const event: VerifiedChainEvent = { id: wallet + i, chainId: 5042, address: escrow, blockNumber: '1', blockHash: hash('0x1'), transactionHash: hash(wallet + i), transactionIndex: 0, logIndex: i, timestamp: '2023-11-14T22:13:20.000Z', name: 'Withdrawn', args: { account: wallet, amount: '9007199254740993' } };
    return e.CHAIN_DB.prepare('INSERT INTO events(id,block_number,body) VALUES(?,?,?)').bind(event.id, '1', JSON.stringify(event));
  }));
}
it('isolates a small wallet from more than 256 unrelated canonical events', async () => {
  const e = environment(), f = new Fixture();
  expect((await handle(new Request('https://private/v1/sync', { method: 'POST', body: '{}' }), e, f.transport)).status).toBe(200);
  await seed(e, 300, '0x5555555555555555555555555555555555555555'); await seed(e, 1);
  const response = await handle(request({ wallet: customer }), e, f.transport);
  expect(response.status).toBe(200);
  expect((await response.json() as ChainSnapshot).events).toHaveLength(1);
});
it('returns all 300 relevant wallet events in bounded immutable pages', async () => {
  const e = environment(), f = new Fixture();
  await handle(new Request('https://private/v1/sync', { method: 'POST', body: '{}' }), e, f.transport); await seed(e, 300);
  const ids = new Set<string>(); let pageToken: string | undefined; let pages = 0; let snapshotId: string | undefined;
  do {
    const response = await handle(request({ wallet: customer, ...(pageToken ? { pageToken } : {}) }), e, f.transport);
    expect(response.status).toBe(200);
    const page = await response.json() as ChainSnapshot;
    expect(page.events.length).toBeLessThanOrEqual(64);
    expect(page.pagination).toBeDefined();
    snapshotId ??= page.pagination!.snapshotId;
    expect(page.pagination!.snapshotId).toBe(snapshotId);
    for (const event of page.events) { expect(ids.has(event.id)).toBe(false); ids.add(event.id); }
    pageToken = page.pagination!.nextToken ?? undefined; pages++;
  } while (pageToken);
  expect(ids.size).toBe(300); expect(pages).toBe(5);
});
it('accepts an authenticated-service customer scope but rejects forged page state', async () => {
  const e = environment(), f = new Fixture();
  await handle(new Request('https://private/v1/sync', { method: 'POST', body: '{}' }), e, f.transport);
  const response = await handle(new Request('https://private/v1/customer-snapshot', {method:'POST',body:JSON.stringify({orgIds:['org'],wallets:[customer]})}), e, f.transport);
  expect(response.status).toBe(200);
  expect((await response.json() as ChainSnapshot).bindings).toEqual([]);
});
it.each(['wallet','forged','expired','cursor'] as const)('rejects %s continuation tokens without partial success', async fault => {
  const e = environment(), f = new Fixture();
  await handle(new Request('https://private/v1/sync', { method: 'POST', body: '{}' }), e, f.transport); await seed(e, 70);
  const first = await (await handle(request({wallet:customer}),e,f.transport)).json() as ChainSnapshot;
  let token = first.pagination!.nextToken!;
  if(fault==='forged')token=crypto.randomUUID();
  if(fault==='expired')await e.CHAIN_DB.prepare('UPDATE history_pages SET expires=0 WHERE token=?').bind(token).run();
  if(fault==='cursor'){f.head='0x2';await handle(new Request('https://private/v1/sync',{method:'POST',body:'{}'}),e,f.transport);}
  const response = await handle(request({wallet:fault==='wallet'?merchant:customer,pageToken:token}),e,f.transport);
  expect(response.status).not.toBe(200);
});
it('rejects a cross-tenant token and late binding changes', async () => {
  const e = environment(), f = new Fixture();
  await handle(new Request('https://private/v1/sync', { method:'POST',body:'{}' }),e,f.transport);
  const orgId='org',key=actorKey(merchant,reference(orgId,'plan','p'));
  const bound={orgId,kind:'plan',recordId:'p',key,merchant};
  await handle(new Request('https://private/v1/bind',{method:'POST',body:JSON.stringify(bound)}),e,f.transport);
  f.getters.getPlan={merchant,payout:merchant,amount:1n,interval:2592000,trial:0,grace:0,vestDuration:0,arbitrator:merchant,customerMayRefundUnvested:false,active:true};
  await e.CHAIN_DB.batch(Array.from({length:70},(_,i)=>e.CHAIN_DB.prepare('INSERT INTO events(id,block_number,body) VALUES(?,?,?)').bind('p'+i,'1',JSON.stringify({id:'p'+i,address:settings.ARC_MANAGER_ADDRESS,blockNumber:'1',name:'PlanUpdated',args:{planKey:key,merchant}}))));
  const req=(orgId:string,pageToken?:string)=>new Request('https://private/v1/snapshot',{method:'POST',body:JSON.stringify({orgId,...(pageToken?{pageToken}:{})})});
  const first=await (await handle(req(orgId),e,f.transport)).json() as ChainSnapshot;
  expect(first.pagination!.nextToken).toBeTruthy();
  expect((await handle(req('other',first.pagination!.nextToken!),e,f.transport)).status).toBe(400);
  await handle(new Request('https://private/v1/bind',{method:'POST',body:JSON.stringify({...bound,recordId:'late',key:actorKey(merchant,reference(orgId,'plan','late'))})}),e,f.transport);
  expect((await handle(req(orgId,first.pagination!.nextToken!),e,f.transport)).status).toBe(400);
});
it('does not page through subscription payment history just to read a bound plan',async()=>{
 const e=environment(),f=new Fixture(),orgId='plan-only';
 await handle(new Request('https://private/v1/sync',{method:'POST',body:'{}'}),e,f.transport);
 const key=actorKey(merchant,reference(orgId,'plan','p'));
 await handle(new Request('https://private/v1/bind',{method:'POST',body:JSON.stringify({orgId,kind:'plan',recordId:'p',key,merchant})}),e,f.transport);
 f.getters.getPlan={merchant,payout:merchant,amount:1n,interval:2592000,trial:0,grace:0,vestDuration:0,arbitrator:merchant,customerMayRefundUnvested:false,active:true};
 await e.CHAIN_DB.batch(Array.from({length:300},(_,i)=>e.CHAIN_DB.prepare('INSERT INTO events(id,block_number,body) VALUES(?,?,?)').bind('unrelated'+i,'1',JSON.stringify({id:'unrelated'+i,address:settings.ARC_MANAGER_ADDRESS,blockNumber:'1',name:'SubscriptionPaymentProcessed',args:{planKey:key,subKey:hash('other-sub'+i)}}))));
 const response=await handle(new Request('https://private/v1/snapshot',{method:'POST',body:JSON.stringify({orgId})}),e,f.transport);
 expect(response.status).toBe(200);expect(await response.json()).toMatchObject({events:[],pagination:{complete:true,nextToken:null}});
});
it('collects exact 300-payment tenant revenue and finds a paid proof outside the current history page', async () => {
  const e=environment(),f=new Fixture(),orgId='revenue';
  const call=(route:string,body:unknown={})=>handle(new Request('https://private/v1/'+route,{method:'POST',body:JSON.stringify(body)}),e,f.transport);
  await call('sync');
  const planKey=actorKey(merchant,reference(orgId,'plan','p')),subKey=actorKey(customer,reference(orgId,'subscription','s'));
  const bound=[{orgId,kind:'plan',recordId:'p',key:planKey,merchant},{orgId,kind:'subscription',recordId:'s',key:subKey,planKey,merchant,customer},{orgId,kind:'invoice',recordId:'invoice',key:chargeReference(subKey,'300'),planKey,subscriptionKey:subKey,merchant,customer,amount:'9007199254740993',chargeNumber:'300'}];
  for(const b of bound)expect((await call('bind',b)).status).toBe(200);
  f.getters.getPlan={merchant,payout:merchant,amount:9007199254740993n,interval:2592000,trial:0,grace:0,vestDuration:0,arbitrator:merchant,customerMayRefundUnvested:false,active:true};
  f.getters.getSubscription={customer,planKey,amount:9007199254740993n,interval:2592000,grace:0,nextChargeAt:1702592000,chargeCount:300,acceptedArbitrator:merchant,status:1};
  f.getters.getMandate={perChargeCap:0n,totalCap:0n,spent:0n,expiry:0,nonce:0,active:false};
  await seed(e,300); // Unrelated wallet events must not affect tenant page size or totals.
  await e.CHAIN_DB.batch(Array.from({length:300},(_,i)=>{
    const event:VerifiedChainEvent={id:'revenue'+i,chainId:5042,address:settings.ARC_MANAGER_ADDRESS as `0x${string}`,blockNumber:'1',blockHash:hash('0x1'),transactionHash:hash('revenue'+i),transactionIndex:0,logIndex:i,timestamp:'2023-11-14T22:13:20.000Z',name:'SubscriptionPaymentProcessed',args:{subKey,planKey,merchant,customer,chargeNumber:String(i+1),amount:'9007199254740993',periodStart:'1700000000',nextChargeAt:'1702592000'}};
    return e.CHAIN_DB.prepare('INSERT INTO events(id,block_number,body) VALUES(?,?,?)').bind(event.id,'1',JSON.stringify(event));
  }));
  const first=await (await call('snapshot',{orgId})).json() as ChainSnapshot;
  expect(first.events).toHaveLength(64);expect(first.events.some(e=>e.args.chargeNumber==='300')).toBe(false);
  expect(first.projections.find(p=>p.kind==='invoice')).toMatchObject({state:'paid',transactionHash:hash('revenue299')});
  const state=await collectChainPages(async pageToken=>{const response=await call('snapshot',{orgId,...(pageToken?{pageToken}:{})});expect(response.status).toBe(200);return response.json() as Promise<ChainSnapshot>});
  expect(state.events).toHaveLength(300);
  const ledger=state.projections.filter(p=>p.kind==='ledger');expect(ledger).toHaveLength(300);
  expect(ledger.reduce((sum,p)=>sum+BigInt(String(p.values.amount)),0n)).toBe(300n*9007199254740993n);
  const customerState=await collectChainPages(async pageToken=>{const response=await call('customer-snapshot',{orgIds:[orgId],wallets:[customer],...(pageToken?{pageToken}:{})});expect(response.status).toBe(200);return response.json() as Promise<ChainSnapshot>});
  expect(customerState.events).toHaveLength(300);expect(customerState.projections.filter(p=>p.kind==='ledger')).toHaveLength(300);
});
it('keeps a dense 26-plan page inside 40 RPC and bounded D1 invocations',async()=>{
 const e=environment(),f=new Fixture();
 await handle(new Request('https://private/v1/sync',{method:'POST',body:'{}'}),e,f.transport);
 const bound=Array.from({length:26},(_,i)=>({orgId:'dense-page',kind:'plan',recordId:'p'+i,key:actorKey(merchant,reference('dense-page','plan','p'+i)),merchant}));
 for(const b of bound)expect((await handle(new Request('https://private/v1/bind',{method:'POST',body:JSON.stringify(b)}),e,f.transport)).status).toBe(200);
 f.getters.getPlan={merchant,payout:merchant,amount:1n,interval:2592000,trial:0,grace:0,vestDuration:0,arbitrator:merchant,customerMayRefundUnvested:false,active:true};
 await e.CHAIN_DB.batch(bound.flatMap((b,j)=>Array.from({length:70},(_,i)=>e.CHAIN_DB.prepare('INSERT INTO events(id,block_number,body) VALUES(?,?,?)').bind(`dense-${j}-${i}`,'1',JSON.stringify({id:`dense-${j}-${i}`,address:settings.ARC_MANAGER_ADDRESS,blockNumber:'1',name:'PlanUpdated',args:{planKey:b.key,merchant}})))));
 let invocations=0,read=0;const db=e.CHAIN_DB;
 const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){if(key==='bind')return(...values:unknown[])=>wrap(target.bind(...values));if(['first','all','run','raw'].includes(String(key)))return(...args:unknown[])=>{invocations++;return Reflect.get(target,key).apply(target,args)};return Reflect.get(target,key)}});
 e.CHAIN_DB=new Proxy(db,{get(target,key){if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql));if(key==='batch')return async(statements:D1PreparedStatement[])=>{invocations++;const result=await target.batch(statements);read+=result.reduce((n,r)=>n+r.meta.rows_read,0);return result};return Reflect.get(target,key)}});
 f.calls=[];
 const response=await handle(new Request('https://private/v1/snapshot',{method:'POST',body:JSON.stringify({orgId:'dense-page'})}),e,f.transport);
 expect(response.status).toBe(200);expect((await response.json() as ChainSnapshot).events).toHaveLength(64);expect(f.calls).toHaveLength(40);expect(invocations).toBeLessThanOrEqual(9);
 console.info(JSON.stringify({fixture:'dense-26-plan-page',rpcCalls:f.calls.length,d1Invocations:invocations,batchedRowsRead:read,storedRelevantEvents:1820,returnedEvents:64}));
});
it('uses indexed bounded rowid seeks rather than a history scan or OFFSET',async()=>{
 const e=environment();
 for(const [index,field] of [['events_plan','planKey'],['events_subscription','subKey'],['events_escrow','escrowKey'],['events_account','account']]){
  const plan=await e.CHAIN_DB.prepare(`EXPLAIN QUERY PLAN SELECT rowid,body FROM events INDEXED BY ${index} WHERE json_extract(body,'$.address')=? AND json_extract(body,'$.args.${field}')=? ${index==='events_plan'?"AND json_extract(body,'$.name') IN ('PlanCreated','PlanUpdated')":''} AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 65`).bind(escrow,customer,0,100).all<{detail:string}>();
  expect(plan.results.some(p=>p.detail.includes('SEARCH events USING INDEX '+index))).toBe(true);
  expect(plan.results.some(p=>p.detail.includes('TEMP B-TREE'))).toBe(false);
 }
});
