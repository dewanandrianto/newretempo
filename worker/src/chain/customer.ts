import type { ChainSnapshot } from '../../../shared/chain'
import { requireWorkerAuth } from '../auth/guards'
import { forbidden, unavailable } from '../errors'
import { configuration, snapshot, privateRequest } from './client'
import { historyToken } from './routes'
import type { C } from './plans'
export async function customerSnapshot(c:C){
 const auth=requireWorkerAuth(c)
 const wallets=await c.env.DB.prepare("SELECT address FROM wallets WHERE user_id=? AND purpose='login' AND verified_at IS NOT NULL AND verification_method='siwe' AND chain_id=5042002 ORDER BY address LIMIT 33").bind(auth.userId).all<{address:string}>()
 if(!wallets.results.length)throw forbidden('A verified session wallet is required')
 if(wallets.results.length>32)throw unavailable('Customer wallet capacity exceeded','customer_snapshot_capacity')
 const addresses=new Set(wallets.results.map(w=>w.address))
 const tenants=await c.env.DB.prepare("SELECT DISTINCT cw.org_id FROM wallets cw JOIN wallets lw ON lw.address=cw.address AND lw.chain_id=cw.chain_id WHERE cw.purpose='customer' AND lw.purpose='login' AND lw.user_id=? AND lw.verified_at IS NOT NULL AND lw.verification_method='siwe' AND lw.chain_id=5042002 LIMIT 21").bind(auth.userId).all<{org_id:string}>()
 // Bound public service fanout; never return a silently truncated financial history.
 // This local safety ceiling is not proof of production CPU or descendant subrequest budgets.
 if(tenants.results.length>20)throw unavailable('Customer history exceeds the supported tenant capacity','customer_snapshot_capacity')

 const result:ChainSnapshot={configuration:await configuration(c.env),cursor:null,bindings:[],projections:[],events:[]}
 let pinnedCursor:string|undefined
 for(const tenant of tenants.results){
  const state=await snapshot(c.env,tenant.org_id)
  if(state.pagination&&!state.pagination.complete)throw unavailable('Use the paginated customer history endpoint','customer_snapshot_capacity')
  if(pinnedCursor!==undefined&&pinnedCursor!==JSON.stringify(state.cursor))throw unavailable('Customer cursor changed; retry complete history','chain_unavailable')
  pinnedCursor=JSON.stringify(state.cursor)
  const owned=state.bindings.filter(b=>b.customer&&addresses.has(b.customer))
  const plans=new Set(owned.map(b=>b.planKey))
  const bindings=state.bindings.filter(b=>owned.includes(b)||(b.kind==='plan'&&plans.has(b.key)))
  const keys=new Set(owned.map(b=>b.key)),ids=new Set(bindings.map(b=>b.recordId))
  result.bindings.push(...bindings)
  result.projections.push(...state.projections.filter(p=>ids.has(p.recordId)||keys.has(p.key)||addresses.has(String(p.values.customer??p.values.account??''))))
  result.events.push(...state.events.filter(e=>addresses.has(String(e.args.customer??e.args.account??''))||Object.values(e.args).some(v=>typeof v==='string'&&keys.has(v as `0x${string}`))))
  if(state.cursor&&(!result.cursor||BigInt(state.cursor.blockNumber)<BigInt(result.cursor.blockNumber)))result.cursor=state.cursor
 }
 // Cross-tenant event repeats are possible for a wallet; return each canonical event once.
 result.events=[...new Map(result.events.map(e=>[e.id,e])).values()]
 c.header('Cache-Control','no-store')
 return c.json(result)
}
/** One private indexed page per public request; re-authorize the entire customer scope each time. */
export async function customerSnapshotPage(c:C){
 const auth=requireWorkerAuth(c)
 const wallets=await c.env.DB.prepare("SELECT address FROM wallets WHERE user_id=? AND purpose='login' AND verified_at IS NOT NULL AND verification_method='siwe' AND chain_id=5042002 ORDER BY address LIMIT 33").bind(auth.userId).all<{address:string}>()
 if(!wallets.results.length)throw forbidden('A verified session wallet is required')
 if(wallets.results.length>32)throw unavailable('Customer wallet capacity exceeded','customer_snapshot_capacity')
 const addresses=[...new Set(wallets.results.map(w=>w.address.toLowerCase()))]
 const tenants=await c.env.DB.prepare("SELECT DISTINCT cw.org_id FROM wallets cw JOIN wallets lw ON lw.address=cw.address AND lw.chain_id=cw.chain_id WHERE cw.purpose='customer' AND lw.purpose='login' AND lw.user_id=? AND lw.verified_at IS NOT NULL AND lw.verification_method='siwe' AND lw.chain_id=5042002 ORDER BY cw.org_id LIMIT 21").bind(auth.userId).all<{org_id:string}>()
 if(tenants.results.length>20)throw unavailable('Customer history exceeds the supported tenant capacity','customer_snapshot_capacity')
 const orgIds=tenants.results.map(t=>t.org_id), token=historyToken(c)
 const state=await privateRequest<ChainSnapshot>(c.env,'/v1/customer-snapshot',{orgIds,wallets:addresses,...(token?{pageToken:token}:{})})
 const owned=state.bindings.filter(b=>b.customer&&addresses.includes(b.customer))
 const plans=new Set(owned.map(b=>b.orgId+':'+b.planKey))
 if(state.bindings.some(b=>!orgIds.includes(b.orgId)||!(owned.includes(b)||b.kind==='plan'&&plans.has(b.orgId+':'+b.key))) || state.projections.some(p=>!state.bindings.some(b=>b.orgId===p.orgId&&(b.recordId===p.recordId||b.key===p.key))))throw unavailable('Customer snapshot ownership mismatch','chain_unavailable')
 c.header('Cache-Control','no-store')
 return c.json(state)
}
