import { env } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import worker from '../src/service';
import { Fixture, settings, hash, paymentLog } from './fixtures';
import type { Env } from '../src/service';
async function run(e:Env,transport:typeof fetch){
 const tasks:Promise<unknown>[]=[];
 const context={waitUntil:(task:Promise<unknown>)=>tasks.push(task)} as ExecutionContext;
 // The injectable transport is only a local test seam; the platform supplies no fourth argument.
 worker.scheduled({} as ScheduledController,e,context,transport);
 await Promise.all(tasks);
}
it.each([undefined,'false','TRUE'])('does no work with cron flag %s',async flag=>{
 const f=new Fixture(),e={...env,...settings,ARC_SYNC_CRON_ENABLED:flag} as unknown as Env;
 await run(e,f.transport);expect(f.calls).toHaveLength(0);
 expect(await e.CHAIN_DB.prepare('SELECT cursor FROM runtime').first()).toMatchObject({cursor:null});
});
it('uses bounded atomic sync from the scheduled entry point and sanitizes failures',async()=>{
 const f=new Fixture(),e={...env,...settings,ARC_SYNC_CRON_ENABLED:'true'} as unknown as Env;
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
 f.logs=[paymentLog(hash('s'),hash('p'))];f.badReceipt=true;
 await run(e,f.transport);
 expect(log).toHaveBeenCalledWith('Retempo scheduled chain sync failed', {code:'verification_failed'});
 expect(await e.CHAIN_DB.prepare('SELECT cursor FROM runtime').first()).toMatchObject({cursor:null});
 expect(await e.CHAIN_DB.prepare('SELECT COUNT(*) AS n FROM events').first()).toMatchObject({n:0});
 f.badReceipt=false;f.calls=[];await run(e,f.transport);
 expect(f.calls.length).toBeLessThanOrEqual(40);
 expect(JSON.parse((await e.CHAIN_DB.prepare('SELECT cursor FROM runtime').first<{cursor:string}>())!.cursor).blockNumber).toBe('1');
 expect(await e.CHAIN_DB.prepare('SELECT COUNT(*) AS n FROM events').first()).toMatchObject({n:1});
 }finally{log.mockRestore()}
});
it('requires production identity pins even when the cron is explicitly enabled',async()=>{
 const f=new Fixture(),e={...env,...settings,APP_ENV:'production',ARC_RPC_URL:'https://rpc.blockdaemon.testnet.arc.io',ARC_SYNC_CRON_ENABLED:'true'} as unknown as Env;
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{await run(e,f.transport);expect(f.calls).toHaveLength(0);expect(log).toHaveBeenCalledWith('Retempo scheduled chain sync failed',{code:'verification_failed'});}finally{log.mockRestore()}
});
