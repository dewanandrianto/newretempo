import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi } from 'viem';
import { handle, type Env } from '../../chain-worker/src/service';
import { Fixture, settings, hash, paymentLog, escrow, customer, merchant, escrowAbi } from '../../chain-worker/tests/fixtures';
const request=(route:string,body:unknown={})=>new Request('https://private/v1/'+route,{method:'POST',body:JSON.stringify(body)});
const environment=()=>({...env,...settings}) as unknown as Env;
it('REPRO: reorg after initial cursor check is not caught before extending cursor and serves orphan proof',async()=>{
 const e=environment(),f=new Fixture();
 const abi=escrowAbi as Abi;
 const def=abi.find(x=>x.type==='event'&&x.name==='Withdrawn')!;
 if(def.type!=='event')throw Error('fixture');
 const args:Record<string,unknown>={account:customer,to:merchant,amount:123n};
 const fields=def.inputs.filter(x=>!x.indexed);
 f.logs=[{address:escrow,blockNumber:'0x1',blockHash:hash('0x1'),transactionHash:hash('orphan-withdrawal'),transactionIndex:'0x0',logIndex:'0x0',removed:false,topics:encodeEventTopics({abi,eventName:'Withdrawn',args}),data:encodeAbiParameters(fields,fields.map(x=>args[x.name!]))}];
 expect((await handle(request('sync'),e,f.transport)).status).toBe(200);
 f.logs=[];f.head='0x2';let reorganized=false;let oldCursorReads=0;
 const transport:typeof fetch=async(input,init)=>{
  const q=JSON.parse(String(init?.body));
  if(q.method==='eth_getBlockByNumber'&&q.params[0]==='0x1'){
   oldCursorReads++;
   if(reorganized)return Response.json({result:{number:'0x1',hash:hash('fork-B-1'),timestamp:'0x6553f100'}});
  }
  if(q.method==='eth_blockNumber')reorganized=true;
  return f.transport(input,init);
 };
 const second=await handle(request('sync'),e,transport);
 const runtime=await e.CHAIN_DB.prepare('SELECT cursor,halted FROM runtime').first<{cursor:string;halted:string|null}>();
 const walletResponse=await handle(request('wallet-snapshot',{wallet:customer}),e,transport);
 const wallet=await walletResponse.json() as {events:{id:string;blockHash:string}[];cursor:{blockNumber:string}};
 console.info(JSON.stringify({repro:'mid-scan-ancestor-reorg',syncStatus:second.status,oldCursorReads,runtime,walletStatus:walletResponse.status,returnedEvents:wallet.events}));
 expect(second.status).toBe(200);expect(JSON.parse(runtime!.cursor).blockNumber).toBe('2');expect(runtime!.halted).toBeNull();expect(oldCursorReads).toBe(1);
 expect(walletResponse.status).toBe(200);expect(wallet.events).toHaveLength(1);expect(wallet.events[0].blockHash).toBe(hash('0x1'));
});
it('REPRO: oversized multiblock logs response never retries smaller individually admissible blocks',async()=>{
 const e=environment(),f=new Fixture();f.head='0x20';
 const logs=Array.from({length:512},(_,i)=>({...paymentLog(hash('s'),hash('p')),blockNumber:'0x'+(1+Math.floor(i/16)).toString(16),blockHash:hash('0x'+(1+Math.floor(i/16)).toString(16)),transactionHash:hash('block-tx-'+Math.floor(i/16)),logIndex:'0x'+(i%16).toString(16)}));
 const bytes=new TextEncoder().encode(JSON.stringify({result:logs})).length;expect(bytes).toBeGreaterThan(524288);
 const ranges:string[][]=[];
 const transport:typeof fetch=async(input,init)=>{
  const q=JSON.parse(String(init?.body));
  if(q.method==='eth_getLogs'){ranges.push([q.params[0].fromBlock,q.params[0].toBlock]);return Response.json({result:logs.filter(l=>BigInt(l.blockNumber)>=BigInt(q.params[0].fromBlock)&&BigInt(l.blockNumber)<=BigInt(q.params[0].toBlock))});}
  if(q.method==='eth_getTransactionReceipt')return Response.json({result:{status:'0x1',transactionHash:logs[0].transactionHash,blockHash:hash('0x1'),blockNumber:'0x1',transactionIndex:'0x0',logs:logs.slice(0,16)}});
  return f.transport(input,init);
 };
 const statuses=[];
 for(let i=0;i<2;i++)statuses.push((await handle(request('sync'),e,transport)).status);
 const state=await e.CHAIN_DB.prepare('SELECT cursor,halted FROM runtime').first();
 console.info(JSON.stringify({repro:'oversized-multiblock-response',responseBytes:bytes,singleBlockBytes:new TextEncoder().encode(JSON.stringify({result:logs.slice(0,16)})).length,statuses,ranges,state}));
 expect(statuses).toEqual([503,503]);expect(ranges).toEqual([['0x1','0x20'],['0x1','0x20']]);expect(state).toMatchObject({cursor:null,halted:null});
 f.head='0x1';const single=await handle(request('sync'),e,transport);const singleBody=await single.json();
 console.info(JSON.stringify({repro:'same-first-block-alone',status:single.status,body:singleBody}));
 expect(single.status).toBe(200);expect(singleBody).toMatchObject({processedEvents:16,cursor:{blockNumber:'1'}});
});
