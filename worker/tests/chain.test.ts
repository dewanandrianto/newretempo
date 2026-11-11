import { env as testEnv } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createWorkerApp } from '../src/index'
import type { WorkerBindings } from '../src/types'
import { configuredConfiguration, enabledConfiguration } from '../src/chain/client'
import type { ChainConfiguration } from '../../shared/chain'
import { actorKey, chargeKeys, serverReference } from '../src/chain/keys'
import { overlay } from '../src/chain/projections'
import { encodeAbiParameters, keccak256 } from 'viem'
const env = testEnv as unknown as WorkerBindings
const app = createWorkerApp()
describe('public chain bridge in workerd', () => {
  it('returns disabled configuration without inventing deployment addresses', async () => {
    const response = await app.request('http://local/api/chain/config', {}, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ configured: false, manager: null, escrow: null, managerPaused: null, escrowPaused: null, mode: 'disabled' })
  })
  it('keeps read-only verification available while financial preparation fails closed on paused or unknown state', async () => {
    const base: ChainConfiguration = { chainId:5042002, mode:'testnet', configured:true, rpcUrl:'https://rpc.blockdaemon.testnet.arc.io/', explorerUrl:'https://explorer.testnet.arc.io', manager:'0x3333333333333333333333333333333333333333', escrow:'0x4444444444444444444444444444444444444444', managerPaused:true, escrowPaused:true, usdc:'0x3600000000000000000000000000000000000000', usdcDecimals:6, startBlock:'1' }
    const bridge = (managerPaused:boolean|null, escrowPaused:boolean|null) => ({ CHAIN:{fetch:()=>Promise.resolve(Response.json({...base,managerPaused,escrowPaused}))} }) as unknown as WorkerBindings
    const paused = bridge(true,true)
    expect(await configuredConfiguration(paused)).toMatchObject({configured:true,managerPaused:true,escrowPaused:true})
    await expect(enabledConfiguration(paused)).rejects.toThrow('paused or pause state is unavailable')
    await expect(enabledConfiguration(bridge(null,false))).rejects.toThrow('paused or pause state is unavailable')
    await expect(enabledConfiguration(bridge(true,false))).rejects.toThrow('paused or pause state is unavailable')
    await expect(enabledConfiguration(bridge(false,true))).rejects.toThrow('paused or pause state is unavailable')
    await expect(enabledConfiguration(bridge(false,false))).resolves.toMatchObject({configured:true,managerPaused:false,escrowPaused:false})
  })
  it('requires authentication for sync and tenant snapshots', async () => {
    expect((await app.request('http://local/api/chain/sync', { method: 'POST', headers: { Origin: 'https://app.test', 'X-Requested-With': 'retempo' } }, env)).status).toBe(401)
    expect((await app.request(`http://local/api/orgs/${crypto.randomUUID()}/chain/snapshot`, {}, env)).status).toBe(401)
  })
  it('maps real private escrow lifecycle and dispute states to legacy DTO states', () => {
    for (const [state,values,status] of [
      ['missing',{},'pending_funding'], ['pending',{},'pending_funding'], ['active',{},'funded'],
      ['active',{dispute:'open'},'disputed'], ['closed',{outcome:'fully_vested'},'released'],
      ['closed',{outcome:'refunded'},'refunded'], ['closed',{outcome:'resolved'},'settled'],
    ] as const) {
      const result=overlay({id:'record',status:'pending_funding'},'escrow',[{orgId:'org',kind:'escrow',recordId:'record',key:'0x00',state,values,blockNumber:'1',transactionHash:null}])
      expect(result.status).toBe(status)
    }
  })
  it('projects subscription period from verified due time and payment period only', () => {
    const result=overlay({id:'sub',status:'incomplete',currentPeriodStart:null,currentPeriodEnd:null},'subscription',[
      {orgId:'org',kind:'subscription',recordId:'sub',key:'0x01',state:'active',values:{nextChargeAt:'2026-12-01T00:00:00.000Z'},blockNumber:'1',transactionHash:null},
      {orgId:'org',kind:'payment',recordId:'payment',key:'0x02',state:'paid',values:{subKey:'0x01',chargeNumber:'1',periodStart:'2026-11-01T00:00:00.000Z'},blockNumber:'1',transactionHash:null},
    ])
    expect(result).toMatchObject({status:'active',currentPeriodStart:'2026-11-01T00:00:00.000Z',currentPeriodEnd:'2026-12-01T00:00:00.000Z'})
  })
  it('derives domain-separated references and exact Solidity ABI keys', () => {
    const wallet = '0x1111111111111111111111111111111111111111'
    const ref = serverReference('org', 'subscription', 'id')
    expect(ref).not.toBe(serverReference('other', 'subscription', 'id'))
    expect(actorKey(wallet, ref)).toBe(keccak256(encodeAbiParameters([{type:'address'},{type:'bytes32'}], [wallet, ref])))
    const charge = chargeKeys(actorKey(wallet, ref), '9007199254740993', wallet)
    expect(charge.invoiceRef).toBe(keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'}], [actorKey(wallet, ref), 9007199254740993n])))
    expect(charge.escrowKey).toBe(actorKey(wallet, charge.invoiceRef))
  })
})
