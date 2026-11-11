import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { keccak256 } from 'viem';
import { handle, type Env } from '../src/service';
import { Fixture, settings, hash } from './fixtures';

const config = () => new Request('https://private/v1/config');
const pins = {
  ARC_EXPECTED_GENESIS_HASH: hash('0x0'),
  ARC_EXPECTED_MANAGER_CODE_HASH: keccak256('0x60016000'),
  ARC_EXPECTED_ESCROW_CODE_HASH: keccak256('0x60016000'),
};
const officialTestnetRpcs = [
  'https://rpc.testnet.arc.io',
  'https://rpc.blockdaemon.testnet.arc.io',
];
const production = (rpcUrl = officialTestnetRpcs[1], extra: Record<string, unknown> = {}) => ({
  ...env,
  ...settings,
  APP_ENV: 'production',
  ARC_RPC_URL: rpcUrl,
  ...pins,
  ...extra,
}) as unknown as Env;

it.each(officialTestnetRpcs)('accepts only an exact official Arc Testnet endpoint: %s', async rpcUrl => {
  const f = new Fixture();
  const response = await handle(config(), production(rpcUrl), f.transport);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    configured: true,
    chainId: 5042002,
    mode: 'testnet',
    rpcUrl: `${rpcUrl}/`,
    explorerUrl: 'https://explorer.testnet.arc.io',
    managerPaused: true,
    escrowPaused: true,
  });
});

it('returns actual manager and escrow pause states and null states when disabled', async () => {
  const f = new Fixture();
  f.managerPaused = false;
  f.escrowPaused = false;
  const active = await handle(config(), production(), f.transport);
  expect(active.status).toBe(200);
  expect(await active.json()).toMatchObject({ managerPaused: false, escrowPaused: false });

  const disabled = await handle(config(), { ...env, APP_ENV: undefined } as unknown as Env, f.transport);
  expect(disabled.status).toBe(200);
  expect(await disabled.json()).toMatchObject({ configured: false, managerPaused: null, escrowPaused: null });
});

it.each([settings.ARC_MANAGER_ADDRESS, settings.ARC_ESCROW_ADDRESS])('fails closed on a malformed paused() response from %s', async target => {
  const f = new Fixture();
  const selector = keccak256(new TextEncoder().encode('paused()')).slice(0, 10);
  const transport: typeof fetch = async (input, init) => {
    const q = JSON.parse(String(init?.body)) as { method: string; params: [{ to: string; data: string }] };
    if (q.method === 'eth_call' && q.params[0].to === target && q.params[0].data === selector) return Response.json({ result: '0x' });
    return f.transport(input, init);
  };
  const response = await handle(config(), production(), transport);
  expect(response.status).toBe(503);
});

it.each([
  'https://rpc.arc.network',
  'https://rpc.mainnet.arc.io',
  'https://rpc.blockdaemon.testnet.arc.io.evil.example',
  'https://rpc.blockdaemon.testnet.arc.io/other',
  'https://rpc.blockdaemon.testnet.arc.io/?key=secret',
  'http://rpc.blockdaemon.testnet.arc.io',
  'https://user:secret@rpc.blockdaemon.testnet.arc.io',
])('denies undocumented, mainnet, or unsafe production URL %s without RPC', async url => {
  const f = new Fixture();
  expect((await handle(config(), production(url), f.transport)).status).toBe(503);
  expect(f.calls).toHaveLength(0);
});

it('does not allow a remote Testnet RPC outside the production Worker environment', async () => {
  const f = new Fixture();
  expect((await handle(config(), production(officialTestnetRpcs[1], { APP_ENV: 'test' }), f.transport)).status).toBe(503);
  expect(f.calls).toHaveLength(0);
});

it.each(Object.keys(pins))('requires reviewed remote identity pin %s before any network request', async key => {
  const f = new Fixture();
  expect((await handle(config(), production(officialTestnetRpcs[1], { [key]: undefined }), f.transport)).status).toBe(503);
  expect(f.calls).toHaveLength(0);
});

it.each(Object.keys(pins))('refuses a mismatched remote identity pin %s', async key => {
  const f = new Fixture();
  expect((await handle(config(), production(officialTestnetRpcs[1], { [key]: hash('wrong') }), f.transport)).status).toBe(503);
});
