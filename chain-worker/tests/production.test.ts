import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { keccak256 } from 'viem';
import { handle, type Env } from '../src/service';
import { Fixture, settings, hash } from './fixtures';
const config = () => new Request('https://private/v1/config');
const pins = { ARC_EXPECTED_GENESIS_HASH:hash('0x0'), ARC_EXPECTED_MANAGER_CODE_HASH:keccak256('0x60016000'), ARC_EXPECTED_ESCROW_CODE_HASH:keccak256('0x60016000') };
const production = (extra:Record<string,unknown> = {}) => ({...env,...settings,APP_ENV:'production',ARC_RPC_URL:'https://rpc.mainnet.arc.io',...pins,...extra}) as unknown as Env;
it('accepts only the officially documented primary mainnet RPC and returns its official explorer',async()=>{
  const f=new Fixture(),response=await handle(config(),production(),f.transport);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({configured:true,mode:'mainnet',rpcUrl:'https://rpc.mainnet.arc.io/',explorerUrl:'https://explorer.arc.io'});
});
it.each(['https://rpc.arc.network','https://rpc.mainnet.arc.io.evil.example','https://rpc.mainnet.arc.io/other','https://rpc.mainnet.arc.io/?key=secret','http://rpc.mainnet.arc.io','https://user:secret@rpc.mainnet.arc.io'])('denies undocumented/unsafe production URL %s without RPC',async url=>{
 const f=new Fixture();expect((await handle(config(),production({ARC_RPC_URL:url}),f.transport)).status).toBe(503);expect(f.calls).toHaveLength(0);
});
it.each(Object.keys(pins))('requires reviewed production identity pin %s before any network request',async key=>{
 const f=new Fixture();expect((await handle(config(),production({[key]:undefined}),f.transport)).status).toBe(503);expect(f.calls).toHaveLength(0);
});
it.each(Object.keys(pins))('refuses a mismatched production identity pin %s',async key=>{
 const f=new Fixture();expect((await handle(config(),production({[key]:hash('wrong')}),f.transport)).status).toBe(503);
});
