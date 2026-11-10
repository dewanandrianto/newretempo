import { decodeFunctionResult, encodeFunctionData, keccak256, type Abi, type Hex } from 'viem';
import managerJson from '../../contracts/abi/RetempoSubscriptionManager.json';
import escrowJson from '../../contracts/abi/RetempoEscrow.json';
import type { ChainConfiguration } from '../../shared/chain';
export const managerAbi = managerJson as Abi,
  escrowAbi = escrowJson as Abi;
export interface Env {
  CHAIN_DB: D1Database;
  APP_ENV?: string;
  ARC_SYNC_CRON_ENABLED?: string;
  ARC_RPC_URL?: string;
  ARC_MANAGER_ADDRESS?: string;
  ARC_ESCROW_ADDRESS?: string;
  ARC_START_BLOCK?: string;
  ARC_EXPECTED_GENESIS_HASH?: string;
  ARC_EXPECTED_MANAGER_CODE_HASH?: string;
  ARC_EXPECTED_ESCROW_CODE_HASH?: string;
}
export const USDC = '0x3600000000000000000000000000000000000000' as const;
export const address = /^0x[0-9a-fA-F]{40}$/,
  hash = /^0x[0-9a-fA-F]{64}$/,
  uint = /^(0|[1-9][0-9]*)$/;
export interface RpcBudget { calls: number }
export class OversizedRpcResponseError extends Error {}
export class Rpc {
  constructor(readonly url: string, readonly transport: typeof fetch, readonly budget: RpcBudget = { calls: 0 }) {}
  get remaining(): number { return 40 - this.budget.calls; }
  async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
    if (this.remaining <= 0) throw new CapacityError('RPC request budget exceeded; complete verification unavailable.');
    this.budget.calls++;
    const response = await this.transport.call(globalThis, this.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw Error('RPC unavailable');
    if (!response.body) throw Error('RPC response invalid');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 524288) {
        await reader.cancel();
        throw new OversizedRpcResponseError('RPC response capacity exceeded; complete verification unavailable.');
      }
      chunks.push(value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder().decode(data)) as {
      result: unknown;
      error?: unknown;
    };
    if (body.error || body.result === undefined || body.result === null) throw Error('RPC response invalid');
    return body.result as T;
  }
  async read(to: Hex, abi: Abi, name: string, args: unknown[] = [], block = 'latest'): Promise<unknown> {
    const data = encodeFunctionData({
      abi,
      functionName: name,
      args
    });
    return decodeFunctionResult({
      abi,
      functionName: name,
      data: await this.call<Hex>('eth_call', [{
        to,
        data
      }, block])
    });
  }
}
export async function configuration(env: Env, transport: typeof fetch, budget?: RpcBudget): Promise<ChainConfiguration> {
  const disabled: ChainConfiguration = {
    chainId: 5042,
    mode: 'disabled',
    configured: false,
    rpcUrl: '',
    explorerUrl: 'https://explorer.arc.io',
    usdc: USDC,
    usdcDecimals: 6,
    manager: null,
    escrow: null,
    startBlock: null
  };
  if (!env.APP_ENV || !env.ARC_RPC_URL || !env.ARC_MANAGER_ADDRESS || !env.ARC_ESCROW_ADDRESS || !env.ARC_START_BLOCK) return {
    ...disabled,
    reason: 'Deployment is not configured'
  };
  if (!address.test(env.ARC_MANAGER_ADDRESS) || !address.test(env.ARC_ESCROW_ADDRESS) || !uint.test(env.ARC_START_BLOCK) || env.ARC_MANAGER_ADDRESS.toLowerCase() === env.ARC_ESCROW_ADDRESS.toLowerCase()) throw Error('Invalid deployment configuration');
  const url = new URL(env.ARC_RPC_URL);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !local && url.href !== 'https://rpc.mainnet.arc.io/' || local && !['development', 'test'].includes(env.APP_ENV)) throw Error('Unsafe RPC configuration');
  const expected = [env.ARC_EXPECTED_GENESIS_HASH, env.ARC_EXPECTED_MANAGER_CODE_HASH, env.ARC_EXPECTED_ESCROW_CODE_HASH];
  if (!local && expected.some(value => !value || !hash.test(value))) throw Error('Production identity pins are required');
  const rpc = new Rpc(url.href, transport, budget),
    manager = env.ARC_MANAGER_ADDRESS.toLowerCase() as Hex,
    escrow = env.ARC_ESCROW_ADDRESS.toLowerCase() as Hex;
  if (BigInt(await rpc.call<Hex>('eth_chainId', [])) !== 5042n) throw Error('Chain mismatch');
  const genesis = await rpc.call<{
    hash: Hex;
  }>('eth_getBlockByNumber', ['0x0', false]);
  if (!hash.test(genesis.hash)) throw Error('Invalid genesis');
  const codes = await Promise.all([manager, escrow, USDC].map(a => rpc.call<Hex>('eth_getCode', [a, 'latest'])));
  if (codes.some(c => !/^0x(?:[a-fA-F0-9]{2})+$/.test(c))) throw Error('Missing code');
  if (!local && [genesis.hash, keccak256(codes[0]), keccak256(codes[1])].some((value, index) => value.toLowerCase() !== expected[index]!.toLowerCase())) throw Error('Production identity pin mismatch');
  for (const [to, abi, name, expected] of [[manager, managerAbi, 'usdc', USDC], [manager, managerAbi, 'escrow', escrow], [escrow, escrowAbi, 'usdc', USDC], [escrow, escrowAbi, 'manager', manager]] as const) if (String(await rpc.read(to, abi, name)).toLowerCase() !== expected) throw Error('Contract link mismatch');
  const decimalsAbi = [{
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{
      type: 'uint8'
    }]
  }] as const;
  if (Number(await rpc.read(USDC, decimalsAbi, 'decimals')) !== 6) throw Error('Token decimals mismatch');
  return {
    ...disabled,
    configured: true,
    mode: local ? 'local' : 'mainnet',
    rpcUrl: url.href,
    manager,
    escrow,
    startBlock: env.ARC_START_BLOCK,
    genesisHash: genesis.hash,
    managerCodeHash: keccak256(codes[0]),
    escrowCodeHash: keccak256(codes[1])
  };
}
import { snapshot, walletSnapshot } from './projections';
import { sync, CapacityError } from './indexer';
import { bind, Invalid } from './bindings';
import { pageToken } from './history';
import { customerSnapshot } from './customer';
export async function handle(request: Request, env: Env, transport: typeof fetch = fetch): Promise<Response> {
  const budget: RpcBudget = { calls: 0 };
  const response = await handleRequest(request, env, transport, budget);
  response.headers.set('x-chain-rpc-calls', String(budget.calls));
  response.headers.set('x-chain-rpc-limit', '40');
  return response;
}
async function handleRequest(request: Request, env: Env, transport: typeof fetch, budget: RpcBudget): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/v1/config') return Response.json(await configuration(env, transport, budget));
    if (request.method !== 'POST') throw new Invalid('Invalid method');
    const text = await request.text();
    if (text.length > 16384) throw new Invalid('Request too large');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Invalid('Invalid JSON');
    }
    ;
    if (path === '/v1/sync') {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new Invalid('Sync accepts an empty object only');
      const c = await configuration(env, transport, budget);
      return Response.json(await sync(env, c, new Rpc(c.rpcUrl, transport, budget)));
    }
    if (path === '/v1/bind') {
      if (!(await configuration(env, transport, budget)).configured) throw Error('Disabled');
      return Response.json(await bind(env, body));
    }
    if (path === '/v1/customer-snapshot') {
      const c = await configuration(env, transport, budget);
      return Response.json(await customerSnapshot(env, c, body, new Rpc(c.rpcUrl, transport, budget)));
    }
    if (path === '/v1/wallet-snapshot') {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['wallet','pageToken'].includes(k)) || typeof (body as { wallet?: unknown }).wallet !== 'string' || !address.test((body as { wallet: string }).wallet)) throw new Invalid('Invalid wallet snapshot request');
      const c = await configuration(env, transport, budget);
      return Response.json(await walletSnapshot(env, c, (body as { wallet: string }).wallet.toLowerCase() as Hex, new Rpc(c.rpcUrl, transport, budget), pageToken(body as Record<string,unknown>)));
    }
    if (path === '/v1/snapshot') {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['orgId','pageToken'].includes(k)) || typeof (body as {
        orgId: unknown;
      }).orgId !== 'string') throw new Invalid('Invalid snapshot request');
      const c = await configuration(env, transport, budget);
      return Response.json(await snapshot(env, c, (body as {
        orgId: string;
      }).orgId, new Rpc(c.rpcUrl, transport, budget), pageToken(body as Record<string,unknown>)));
    }
    throw new Invalid('Invalid request');
  } catch (error) {
    return Response.json({
      error: error instanceof Invalid || error instanceof CapacityError || error instanceof OversizedRpcResponseError ? error.message : 'Chain verification failed'
    }, {
      status: error instanceof Invalid ? 400 : 503
    });
  }
}
export default {
  fetch: (request: Request, env: Env) => handle(request, env),
  scheduled: (_controller: ScheduledController, env: Env, context: ExecutionContext, transport: typeof fetch = fetch): void => {
    if (env.ARC_SYNC_CRON_ENABLED !== 'true') return;
    context.waitUntil((async () => {
      const response = await handle(new Request('https://private/v1/sync', { method: 'POST', body: '{}' }), env, transport);
      if (!response.ok) console.error('Retempo scheduled chain sync failed', { code: 'verification_failed' });
    })().catch(() => {
      console.error('Retempo scheduled chain sync failed', { code: 'verification_failed' });
    }));
  }
};
