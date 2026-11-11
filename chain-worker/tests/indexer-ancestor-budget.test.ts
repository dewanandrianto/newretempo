import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { handle, type Env } from '../src/service';
import { Fixture, settings, hash, paymentLog } from './fixtures';
const request = () => new Request('https://private/v1/sync', {method:'POST',body:'{}'});
 it('reserves the final ancestor read while shrinking a sparse advancing scan inside 42 calls', async () => {
  const e = {...env,...settings} as unknown as Env, f = new Fixture();
  expect((await handle(request(),e,f.transport)).status).toBe(200);
  f.head='0x20';
  const logs=Array.from({length:16},(_,i)=>{const blockNumber='0x'+(i+2).toString(16);return {...paymentLog(hash('s'),hash('p')),blockNumber,blockHash:hash(blockNumber),transactionHash:hash('advance'+i)};});
  const ranges:string[]=[]; const methods:string[]=[]; const blockReads:string[]=[];
  const transport:typeof fetch=async(input,init)=>{
    const q=JSON.parse(String(init?.body));methods.push(q.method);
    if(q.method==='eth_getBlockByNumber')blockReads.push(q.params[0]);
    if(q.method==='eth_getLogs'){ranges.push(q.params[0].toBlock);return Response.json({result:logs.filter(l=>BigInt(l.blockNumber)<=BigInt(q.params[0].toBlock))});}
    if(q.method==='eth_getTransactionReceipt'){const log=logs.find(l=>l.transactionHash===q.params[0])!;return Response.json({result:{status:'0x1',transactionHash:log.transactionHash,blockNumber:log.blockNumber,blockHash:log.blockHash,transactionIndex:'0x0',logs:[log]}});}
    return f.transport(input,init);
  };
  const response=await handle(request(),e,transport);const body=await response.json() as {cursor:{blockNumber:string};processedEvents:number};
  console.info(JSON.stringify({fixture:'advancing-sparse-ancestor-reservation',rpcCalls:Number(response.headers.get('x-chain-rpc-calls')),ranges,body,oldCursorReads:blockReads.filter(n=>n==='0x1').length,lastRpc:methods.at(-1),lastBlockRead:blockReads.at(-1)}));
  expect(response.status).toBe(200);expect(Number(response.headers.get('x-chain-rpc-calls'))).toBe(32);
  expect(body.processedEvents).toBe(4);expect(body.cursor.blockNumber).toBe('5');expect(ranges).toEqual(['0x20','0x11','0x9','0x5']);
  expect(blockReads.filter(n=>n==='0x1')).toHaveLength(2);
  expect(methods.at(-1)).toBe('eth_getBlockByNumber');expect(blockReads.at(-1)).toBe('0x1');
  expect(await e.CHAIN_DB.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(body.processedEvents);
});
