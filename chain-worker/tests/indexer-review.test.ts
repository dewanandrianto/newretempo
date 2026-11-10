import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi } from 'viem';
import { handle, type Env } from '../src/service';
import { Fixture, settings, hash, paymentLog, escrow, customer, merchant, escrowAbi } from './fixtures';
const request=(route:string,body:unknown={})=>new Request('https://private/v1/'+route,{method:'POST',body:JSON.stringify(body)});
const environment=()=>({...env,...settings}) as unknown as Env;
it.each([false,true])('PAG-001: ancestor reorg halts advancement and blocks orphan proof (new event=%s)',async(newEvent)=>{
 const e=environment(),f=new Fixture();
 const abi=escrowAbi as Abi;
 const def=abi.find(x=>x.type==='event'&&x.name==='Withdrawn')!;
 if(def.type!=='event')throw Error('fixture');
 const args:Record<string,unknown>={account:customer,to:merchant,amount:123n};
 const fields=def.inputs.filter(x=>!x.indexed);
 f.logs=[{address:escrow,blockNumber:'0x1',blockHash:hash('0x1'),transactionHash:hash('orphan-withdrawal'),transactionIndex:'0x0',logIndex:'0x0',removed:false,topics:encodeEventTopics({abi,eventName:'Withdrawn',args}),data:encodeAbiParameters(fields,fields.map(x=>args[x.name!]))}];
 expect((await handle(request('sync'),e,f.transport)).status).toBe(200);
 const original=f.logs[0];
 f.logs=newEvent?[{...original,blockNumber:'0x2',blockHash:hash('0x2'),transactionHash:hash('new-withdrawal')}]:[];f.head='0x2';let reorganized=false;let oldCursorReads=0;
 const transport:typeof fetch=async(input,init)=>{
  const q=JSON.parse(String(init?.body));
  if(q.method==='eth_getBlockByNumber'&&q.params[0]==='0x1'){
   oldCursorReads++;
   if(reorganized)return Response.json({result:{number:'0x1',hash:hash('fork-B-1'),timestamp:'0x6553f100'}});
  }
  if(q.method==='eth_blockNumber')reorganized=true;
  if(newEvent&&q.method==='eth_getTransactionReceipt')return Response.json({result:{status:'0x1',transactionHash:f.logs[0].transactionHash,blockHash:hash('0x2'),blockNumber:'0x2',transactionIndex:'0x0',logs:f.logs}});
  return f.transport(input,init);
 };
 const second=await handle(request('sync'),e,transport);
 const runtime=await e.CHAIN_DB.prepare('SELECT cursor,halted FROM runtime').first<{cursor:string;halted:string|null}>();
 const walletResponse=await handle(request('wallet-snapshot',{wallet:customer}),e,transport);
 const wallet=await walletResponse.json() as {events:{id:string;blockHash:string}[];cursor:{blockNumber:string}};
 console.info(JSON.stringify({repro:'mid-scan-ancestor-reorg',syncStatus:second.status,oldCursorReads,runtime,walletStatus:walletResponse.status,returnedEvents:wallet.events}));
 expect(second.status).toBe(503);expect(JSON.parse(runtime!.cursor).blockNumber).toBe('1');expect(runtime!.halted).toBe('Canonical cursor mismatch');expect(oldCursorReads).toBe(2);
 expect(await e.CHAIN_DB.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(1);
 expect(walletResponse.status).toBe(503);expect(wallet.events).toBeUndefined();
});
it('PAG-002: oversized multiblock logs shrink to complete individually admissible blocks',async()=>{
 const e=environment(),f=new Fixture();f.head='0x20';
 const logs=Array.from({length:512},(_,i)=>({...paymentLog(hash('s'),hash('p')),blockNumber:'0x'+(1+Math.floor(i/16)).toString(16),blockHash:hash('0x'+(1+Math.floor(i/16)).toString(16)),transactionHash:hash('block-tx-'+Math.floor(i/16)),logIndex:'0x'+(i%16).toString(16)}));
 const bytes=new TextEncoder().encode(JSON.stringify({result:logs})).length;expect(bytes).toBeGreaterThan(524288);
 const ranges:string[][]=[];
 const transport:typeof fetch=async(input,init)=>{
  const q=JSON.parse(String(init?.body));
  if(q.method==='eth_getLogs'){ranges.push([q.params[0].fromBlock,q.params[0].toBlock]);return Response.json({result:logs.filter(l=>BigInt(l.blockNumber)>=BigInt(q.params[0].fromBlock)&&BigInt(l.blockNumber)<=BigInt(q.params[0].toBlock))});}
  if(q.method==='eth_getTransactionReceipt'){const blockLogs=logs.filter(l=>l.transactionHash===q.params[0]);const first=blockLogs[0];return Response.json({result:{status:'0x1',transactionHash:first.transactionHash,blockHash:first.blockHash,blockNumber:first.blockNumber,transactionIndex:'0x0',logs:blockLogs}});}
  return f.transport(input,init);
 };
 const statuses=[];const counts:number[]=[];
 for(let i=0;i<2;i++){const response=await handle(request('sync'),e,transport);statuses.push(response.status);counts.push(Number(response.headers.get('x-chain-rpc-calls')));}
 expect(counts).toEqual([21,23]);expect(await e.CHAIN_DB.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(32);console.info(JSON.stringify({measurement:'overflow-shrinking-rpc',counts}));
 const state=await e.CHAIN_DB.prepare('SELECT cursor,halted FROM runtime').first();
 console.info(JSON.stringify({repro:'oversized-multiblock-response',responseBytes:bytes,singleBlockBytes:new TextEncoder().encode(JSON.stringify({result:logs.slice(0,16)})).length,statuses,ranges,state}));
 expect(statuses).toEqual([200,200]);expect(ranges.slice(0,6)).toEqual([['0x1','0x20'],['0x1','0x10'],['0x1','0x8'],['0x1','0x4'],['0x1','0x2'],['0x1','0x1']]);expect(state).toMatchObject({halted:null});expect(JSON.parse(String(state!.cursor)).blockNumber).toBe('2');
});
