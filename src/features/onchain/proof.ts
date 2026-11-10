import { keccak256, stringToHex, type Address, type Hash } from 'viem'
import type { ChainConfiguration, ChainProjection, ChainSnapshot } from '../../../shared/chain'
export interface ProjectionTarget {kind:ChainProjection['kind']; key?:Hash; recordId?:string; states:readonly string[];eventNames:readonly string[]}
export function transactionId(c:ChainConfiguration,account:Address,action:string,key:string):string {
 return keccak256(stringToHex([c.chainId,c.genesisHash,c.manager?.toLowerCase(),c.escrow?.toLowerCase(),account.toLowerCase(),action,key].join(':')))
}
export function projectionProves(snapshot:ChainSnapshot,hash:Hash,target:ProjectionTarget,expectedConfiguration?:ChainConfiguration):boolean {
 const c=snapshot.configuration
 if(expectedConfiguration&&(['chainId','genesisHash','manager','escrow','managerCodeHash','escrowCodeHash'] as const).some(key=>String(c[key]).toLowerCase()!==String(expectedConfiguration[key]).toLowerCase()))return false
 if(!c.configured||c.chainId!==5042002)return false
 const event=snapshot.events.some(e=>e.transactionHash.toLowerCase()===hash.toLowerCase()&&target.eventNames.includes(e.name)&&(e.address.toLowerCase()===c.manager?.toLowerCase()||e.address.toLowerCase()===c.escrow?.toLowerCase()))
 return event&&Boolean(target.key||target.recordId)&&snapshot.projections.some(p=>p.kind===target.kind&&(!target.key||p.key.toLowerCase()===target.key.toLowerCase())&&(!target.recordId||p.recordId===target.recordId)&&p.transactionHash?.toLowerCase()===hash.toLowerCase()&&target.states.includes(p.state))
}
