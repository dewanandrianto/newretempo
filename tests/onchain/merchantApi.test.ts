import { afterEach, expect, it, vi } from 'vitest'
import { chainApi } from '../../src/services/blockchain/arcService'
import { configuration } from './fixtures'
afterEach(()=>vi.unstubAllGlobals())
it('sends explicit capability creation fields with session credentials rather than UUID public links',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({token:'local-fixture-capability',url:'/checkout/local-fixture-capability',checkout:{id:'fixture'}}),{headers:{'content-type':'application/json'}}))
 vi.stubGlobal('fetch',fetcher)
 const result=await chainApi.createCheckout('org fixture',{subscriptionId:'sub fixture',invoiceId:'invoice fixture',expiresInSeconds:86400})
 expect(result.url).toBe('/checkout/local-fixture-capability')
 const [url,request]=fetcher.mock.calls[0] as unknown as [string,RequestInit]
 expect(url).toBe('/api/orgs/org%20fixture/chain/checkouts')
 expect(request.credentials).toBe('same-origin')
 expect(request.method).toBe('POST')
 expect(JSON.parse(String(request.body))).toEqual({subscriptionId:'sub fixture',invoiceId:'invoice fixture',expiresInSeconds:86400})
})
it('loads wallet-level verification through the authenticated owner endpoint',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({configuration,bindings:[],events:[],projections:[],cursor:null})))
 vi.stubGlobal('fetch',fetcher)
 await chainApi.walletSnapshot(configuration.usdc)
 const [url,request]=fetcher.mock.calls[0] as unknown as [string,RequestInit]
 expect(url).toBe(`/api/wallet/chain/snapshot?wallet=${configuration.usdc}`)
 expect(request.method).toBe('GET');expect(request.credentials).toBe('same-origin')
})
