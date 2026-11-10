import { describe, expect, it } from 'vitest'
import type { ChainSnapshot } from '../../shared/chain'
import { collectChainPages } from '../../shared/chainPages'
const page = (nextToken: string | null, snapshotId = 'snapshot'): ChainSnapshot => ({ configuration: { configured: true } as ChainSnapshot['configuration'], cursor: { blockNumber: '1', blockHash: '0xabc', updatedAt: 'now' }, bindings: [], events: [], projections: [], pagination: { snapshotId, nextToken, complete: nextToken === null, after:(nextToken===null?301:Number(nextToken)||1)-1,through:nextToken===null?301:Number(nextToken)||1,highWater:301 } })
describe('complete chain page collection', () => {
  it('continues beyond arbitrary page counts and yields only the complete result', async () => {
    let calls = 0
    const result = await collectChainPages(async token => { expect(token).toBe(calls ? String(calls) : undefined); calls++; return page(calls === 301 ? null : String(calls)) })
    expect(calls).toBe(301); expect(result.pagination).toBeUndefined()
  })
  it('deduplicates identical canonical proofs across progressing pages',async()=>{
    let calls=0
    const event={id:'canonical',amount:'9007199254740993'} as unknown as ChainSnapshot['events'][number]
    const result=await collectChainPages(async()=>{const after=calls++;return {...page(after===0?'next':null),events:[event],pagination:{snapshotId:'snapshot',nextToken:after===0?'next':null,complete:after!==0,after,through:after+1,highWater:2}}})
    expect(result.events).toEqual([event])
  })
  it.each(['cursor','bindings','event'] as const)('rejects a changed %s across pages',async fault=>{
    let calls=0
    await expect(collectChainPages(async()=>{const after=calls++;const p={...page(after===0?'next':null),pagination:{snapshotId:'snapshot',nextToken:after===0?'next':null,complete:after!==0,after,through:after+1,highWater:2}};if(fault==='event')p.events=[{id:'same',name:after?'changed':'original'} as ChainSnapshot['events'][number]];if(after&&fault==='cursor')p.cursor={...p.cursor!,blockHash:'0xchanged'};if(after&&fault==='bindings')p.bindings=[{recordId:'late'} as ChainSnapshot['bindings'][number]];return p})).rejects.toThrow()
  })
  it('rejects unique tokens that claim no keyset progress', async () => {
    let calls=0
    await expect(collectChainPages(async () => ({ ...page(calls++ ? null : 'next'), pagination: { snapshotId:'snapshot',nextToken:calls===1?'next':null,complete:calls!==1,after:0,through:0,highWater:100 } }))).rejects.toThrow()
  })
  it('fails closed on repeated page tokens', async () => { await expect(collectChainPages(async () => page('loop'))).rejects.toThrow() })
  it('fails closed on snapshot mutation', async () => { let calls = 0; await expect(collectChainPages(async () => page(calls++ ? null : 'next', String(calls)))).rejects.toThrow() })
  it('fails closed when a later page removes pagination', async () => { let calls = 0; await expect(collectChainPages(async () => { const p = page('next'); if (calls++) delete p.pagination; return p })).rejects.toThrow() })
  it('fails closed on incomplete final metadata', async () => { await expect(collectChainPages(async () => ({ ...page(null), pagination: { snapshotId: 'snapshot', nextToken: null, complete: false, after:0,through:0,highWater:0 } }))).rejects.toThrow() })
})
