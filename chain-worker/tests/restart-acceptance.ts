// Explicit synthetic RPC acceptance fixture: this is NOT a real-chain or mainnet test.
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Fixture,manager,escrow,merchant,customer,paymentLog } from './fixtures'
import { actorKey,reference,chargeReference } from '../src/bindings'

const cwd=fileURLToPath(new URL('..',import.meta.url))
const state=await mkdtemp('/home/deseti/.hermes/cache/scratch/retempo-chain-restart-')
const orgId='restart-org', planKey=actorKey(merchant,reference(orgId,'plan','plan')),subKey=actorKey(customer,reference(orgId,'subscription','sub'))
const fixture=new Fixture()
fixture.logs=[paymentLog(subKey,planKey)]
fixture.getters.getPlan={merchant,payout:merchant,amount:9007199254740993n,interval:2592000,trial:0,grace:0,vestDuration:0,arbitrator:merchant,customerMayRefundUnvested:false,active:true}
fixture.getters.getSubscription={customer,planKey,amount:9007199254740993n,interval:2592000,grace:0,nextChargeAt:1702592000,chargeCount:1,acceptedArbitrator:merchant,status:1}
fixture.getters.getMandate={perChargeCap:9007199254740993n,totalCap:18014398509481986n,spent:9007199254740993n,expiry:1709999999,nonce:1,active:true}
const rpc=Bun.serve({hostname:'127.0.0.1',port:18954,fetch:async request=>fixture.transport(request.url,{method:'POST',body:await request.text()})})
const cli='../node_modules/wrangler/bin/wrangler.js'
const migration=spawnSync('node',[cli,'d1','migrations','apply','CHAIN_DB','--local','--config','wrangler.jsonc','--persist-to',state],{cwd,encoding:'utf8'})
assert.equal(migration.status,0,migration.stdout+migration.stderr)
let child:ChildProcess|undefined
let output=''
async function stop(){if(child?.pid){const c=child;child=undefined;process.kill(-c.pid!,'SIGTERM');await new Promise<void>(resolve=>c.once('exit',()=>resolve()))}}
async function start(){output='';child=spawn('node',[cli,'dev','--local','--ip','127.0.0.1','--port','18988','--config','wrangler.jsonc','--persist-to',state,'--var','APP_ENV:test','--var','ARC_RPC_URL:http://127.0.0.1:18954','--var','ARC_MANAGER_ADDRESS:'+manager,'--var','ARC_ESCROW_ADDRESS:'+escrow,'--var','ARC_START_BLOCK:1'],{cwd,detached:true,stdio:['ignore','pipe','pipe']});child.stdout?.on('data',v=>output+=String(v));child.stderr?.on('data',v=>output+=String(v));for(let i=0;i<30;i++){try{const r=await fetch('http://127.0.0.1:18988/v1/config');if(r.ok&&((await r.json()) as {configured:boolean}).configured)return}catch{}if(child.exitCode!==null)throw Error('Worker exited: '+output);await Bun.sleep(250)}throw Error('Worker startup timed out: '+JSON.stringify(fixture.calls)+'\n'+output)}
async function post(route:string,body:unknown){const r=await fetch('http://127.0.0.1:18988/v1/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const b=await r.json() as Record<string,unknown>;assert.equal(r.status,200,JSON.stringify(b)+'\n'+output);return b}
try{
 await start()
 for(const b of [{orgId,kind:'plan',recordId:'plan',key:planKey,merchant},{orgId,kind:'subscription',recordId:'sub',key:subKey,planKey,merchant,customer},{orgId,kind:'invoice',recordId:'invoice',key:chargeReference(subKey,'1'),subscriptionKey:subKey,planKey,merchant,customer,chargeNumber:'1',amount:'9007199254740993'},{orgId,kind:'payment',recordId:'payment',key:chargeReference(subKey,'1'),subscriptionKey:subKey,planKey,merchant,customer,chargeNumber:'1',amount:'9007199254740993'}])await post('bind',b)
 const first=await post('sync',{});assert.equal(first.processedEvents,1)
 const before=await post('snapshot',{orgId});assert.equal((before.events as unknown[]).length,1)
 await stop();await start()
 const replay=await post('sync',{});assert.equal(replay.processedEvents,0)
 const after=await post('snapshot',{orgId});assert.deepEqual(after,before)
 const projections=after.projections as {kind:string;state:string;values:Record<string,unknown>}[]
 assert.equal(projections.find(p=>p.kind==='invoice')?.state,'paid')
 assert.equal(projections.find(p=>p.kind==='invoice')?.values.amount,'9007199254740993')
 assert.equal(projections.filter(p=>p.kind==='ledger').length,1)
 console.log(JSON.stringify({fixtureOnly:true,state,processRestarts:1,indexedEvents:1,replayProcessedEvents:0,persistentBindings:(after.bindings as unknown[]).length,ledgerEntries:1,invoiceState:'paid',amount:'9007199254740993',snapshotIdenticalAfterRestart:true},null,2))
}finally{await stop();await rpc.stop(true)}
