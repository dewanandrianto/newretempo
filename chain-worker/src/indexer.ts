import { decodeEventLog, encodeEventTopics, encodeAbiParameters, encodeEventTopics as topicsFor, type Hex } from 'viem';
import type { ChainConfiguration, ChainCursor, ChainSyncResult, VerifiedChainEvent, ChainValues } from '../../shared/chain';
import { Rpc, OversizedRpcResponseError, hash, managerAbi, escrowAbi, type Env } from './service';
export interface Runtime {
  cursor: string | null;
  fingerprint: string | null;
  halted: string | null;
}
export class CapacityError extends Error {}
export interface RpcBlock {
  number: Hex;
  hash: Hex;
  timestamp: Hex;
}
export interface RpcLog {
  address: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  removed: boolean;
  topics: Hex[];
  data: Hex;
}
interface RpcReceipt {
  status: Hex;
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: Hex;
  transactionIndex: Hex;
  logs: RpcLog[];
}
const hex = (n: bigint): Hex => `0x${n.toString(16)}`;
const quantity = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(v)) throw Error('Invalid RPC quantity');
  return BigInt(v);
};
export async function runtime(env: Env): Promise<Runtime> {
  const r = await env.CHAIN_DB.prepare('SELECT cursor,fingerprint,halted FROM runtime WHERE id=1').first<Runtime>();
  if (!r) throw Error('Database is not migrated');
  return r;
}
export const cursorOf = (r: Runtime): ChainCursor | null => r.cursor ? JSON.parse(r.cursor) as ChainCursor : null;
const fingerprint = (c: ChainConfiguration) => JSON.stringify([c.chainId, c.genesisHash, c.manager, c.managerCodeHash, c.escrow, c.escrowCodeHash, c.startBlock]);
export async function halt(env: Env, reason: string): Promise<never> {
  await env.CHAIN_DB.prepare('UPDATE runtime SET halted=? WHERE id=1').bind(reason).run();
  throw Error(reason);
}
export async function assertCanonical(env: Env, c: ChainConfiguration, rpc: Rpc): Promise<Runtime> {
  const r = await runtime(env);
  if (r.halted) throw Error('Indexer halted');
  if (r.fingerprint && r.fingerprint !== fingerprint(c)) return await halt(env, 'Deployment fingerprint mismatch');
  const cursor = cursorOf(r);
  if (cursor) {
    const block = await rpc.call<RpcBlock>('eth_getBlockByNumber', [hex(BigInt(cursor.blockNumber)), false]);
    if (block.hash !== cursor.blockHash) return await halt(env, 'Canonical cursor mismatch');
  }
  return r;
}
export async function sync(env: Env, c: ChainConfiguration, rpc: Rpc): Promise<ChainSyncResult> {
  let r = await runtime(env);
  const result = (processedEvents = 0, duplicateEvents = 0, busy = false): ChainSyncResult => ({
    configuration: c,
    cursor: cursorOf(r),
    processedEvents,
    duplicateEvents,
    busy
  });
  if (!c.configured) return result();
  const token = crypto.randomUUID(),
    now = Date.now();
  const acquired = await env.CHAIN_DB.prepare('UPDATE runtime SET lease=?,lease_until=? WHERE id=1 AND lease_until<? AND halted IS NULL').bind(token, now + 60000, now).run();
  if (!acquired.meta.changes) {
    if (r.halted) throw Error('Indexer halted');
    return result(0, 0, true);
  }
  try {
    r = await assertCanonical(env, c, rpc);
    const cursor = cursorOf(r);
    const from = cursor ? BigInt(cursor.blockNumber) + 1n : BigInt(c.startBlock!);
    const head = quantity(await rpc.call('eth_blockNumber', []));
    if (head < from) return result();
    let to = head < from + 31n ? head : from + 31n;
    const allowedTopics = [...new Set([...managerAbi, ...escrowAbi].filter(e => e.type === 'event').map(e => String(topicsFor({
      abi: [e],
      eventName: e.name
    })[0])))];
    let logs: RpcLog[];
    for (;;) {
      try {
        logs = await rpc.call<RpcLog[]>('eth_getLogs', [{
          fromBlock: hex(from), toBlock: hex(to), address: [c.manager, c.escrow], topics: [allowedTopics]
        }]);
      } catch (error) {
        // Only a bounded log-response overflow is eligible for prefix shrinking.
        if (!(error instanceof OversizedRpcResponseError)) throw error;
        if (to === from) throw new CapacityError('Single block response capacity exceeded; complete verification unavailable. Cursor unchanged.');
        to = from + (to - from) / 2n;
        continue;
      }
      if (!Array.isArray(logs)) throw Error('Invalid logs');
      const eventBlocks = new Set(logs.map(l => l.blockNumber));
      const transactions = new Set(logs.map(l => l.transactionHash));
      // Receipts, initial + final range blocks, endpoint, and retained ancestor recheck.
      const verificationCalls = transactions.size + 2 * (eventBlocks.size + (eventBlocks.has(hex(to)) ? 0 : 1)) + 1 + (cursor ? 1 : 0);
      if (logs.length <= 256 && new Set(logs.map(l => `${l.transactionHash}:${l.logIndex}`)).size <= 16 && verificationCalls <= rpc.remaining) break;
      if (to === from) throw new CapacityError('Single block capacity exceeded; complete verification is unavailable under the MVP quota. Cursor unchanged.');
      // Retry a complete prefix, never commit a truncated list or a partial block.
      to = from + (to - from) / 2n;
    }
    const blocks = new Map<string, RpcBlock>();
    const receipts = new Map<string, RpcReceipt>();
    const events = new Map<string, VerifiedChainEvent>();
    let duplicateEvents = 0;
    const getBlock = async (n: bigint) => {
      const k = n.toString();
      if (!blocks.has(k)) {
        const b = await rpc.call<RpcBlock>('eth_getBlockByNumber', [hex(n), false]);
        if (quantity(b.number) !== n || !hash.test(b.hash)) throw Error('Invalid block');
        blocks.set(k, b);
      }
      return blocks.get(k)!;
    };
    for (const log of logs) {
      if (!log || typeof log.address !== 'string' || ![c.manager, c.escrow].includes(log.address.toLowerCase() as Hex) || log.removed !== false || !hash.test(log.transactionHash) || !hash.test(log.blockHash) || !Array.isArray(log.topics) || !log.topics.every((t: unknown) => typeof t === 'string' && hash.test(t)) || typeof log.data !== 'string' || !/^0x(?:[a-fA-F0-9]{2})*$/.test(log.data)) throw Error('Invalid log origin or encoding');
      const n = quantity(log.blockNumber),
        index = quantity(log.logIndex),
        txIndex = quantity(log.transactionIndex);
      if (n < from || n > to || index > BigInt(Number.MAX_SAFE_INTEGER) || txIndex > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Log outside range');
      const block = await getBlock(n);
      if (block.hash !== log.blockHash) return await halt(env, 'Log block mismatch');
      if (!receipts.has(log.transactionHash)) receipts.set(log.transactionHash, await rpc.call<RpcReceipt>('eth_getTransactionReceipt', [log.transactionHash]));
      const receipt = receipts.get(log.transactionHash)!;
      if (receipt.status !== '0x1' || receipt.transactionHash !== log.transactionHash || receipt.blockHash !== block.hash || quantity(receipt.blockNumber) !== n || quantity(receipt.transactionIndex) !== txIndex || !Array.isArray(receipt.logs)) throw Error('Invalid receipt');
      const matches = receipt.logs.filter(l => l.logIndex === log.logIndex);
      if (matches.length !== 1) throw Error('Missing receipt log');
      const match = matches[0];
      for (const field of ['address', 'blockNumber', 'blockHash', 'transactionHash', 'transactionIndex', 'logIndex', 'data'] as const) if (match[field] !== log[field]) throw Error('Receipt log mismatch');
      if (JSON.stringify(match.topics) !== JSON.stringify(log.topics) || match.removed !== false) throw Error('Receipt topics mismatch');
      const abi = log.address.toLowerCase() === c.manager ? managerAbi : escrowAbi;
      const decoded = decodeEventLog({
        abi,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
        strict: true
      });
      const eventDef = abi.find(e => e.type === 'event' && e.name === decoded.eventName);
      if (!eventDef || eventDef.type !== 'event') throw Error('Unknown event');
      const args = decoded.args as unknown as Record<string, unknown>;
      const encodedTopics = encodeEventTopics({
        abi: [eventDef],
        eventName: decoded.eventName,
        args
      });
      const unindexed = eventDef.inputs.filter(i => !i.indexed);
      const encodedData = encodeAbiParameters(unindexed, unindexed.map(i => args[i.name!]));
      if (JSON.stringify(encodedTopics) !== JSON.stringify(log.topics) || encodedData !== log.data) throw Error('Noncanonical ABI log');
      const timestamp = new Date(Number(quantity(block.timestamp) * 1000n)).toISOString();
      const normalized: ChainValues = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'boolean' ? v : typeof v === 'string' ? v.toLowerCase() : String(v)]));
      const id = `5042:${log.transactionHash}:${index}`;
      const event: VerifiedChainEvent = {
        id,
        chainId: 5042,
        address: log.address.toLowerCase() as Hex,
        blockNumber: n.toString(),
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: Number(txIndex),
        logIndex: Number(index),
        timestamp,
        name: decoded.eventName!,
        args: normalized
      };
      if (events.has(id)) {
        if (JSON.stringify(events.get(id)) !== JSON.stringify(event)) throw Error('Conflicting duplicate');
        duplicateEvents++;
      } else events.set(id, event);
    }
    const block = await getBlock(to);
    const fresh = await rpc.call<RpcBlock>('eth_getBlockByNumber', [hex(to), false]);
    if (fresh.hash !== block.hash) return await halt(env, 'Canonical block changed during scan');
    // Check every event block again immediately before the atomic commit.
    for (const [number, b] of blocks) {
      const freshBlock = await rpc.call<RpcBlock>('eth_getBlockByNumber', [hex(BigInt(number)), false]);
      if (freshBlock.hash !== b.hash) return await halt(env, 'Canonical block changed during scan');
    }
    const statements: D1PreparedStatement[] = [env.CHAIN_DB.prepare('UPDATE runtime SET lease_until=CASE WHEN lease=? AND lease_until>=? AND halted IS NULL THEN lease_until ELSE -1 END WHERE id=1').bind(token, Date.now())];
    let processedEvents = 0;
    const pending = [...events.values()];
    const existingRows = pending.length ? await env.CHAIN_DB.batch<{body:string}>(pending.map(event => env.CHAIN_DB.prepare('SELECT body FROM events WHERE id=?').bind(event.id))) : [];
    for (const [eventIndex, event] of pending.entries()) {
      const body = JSON.stringify(event);
      const existing = existingRows[eventIndex]?.results[0];
      if (existing) {
        if (existing.body !== body) return await halt(env, 'Stored event mismatch');
        duplicateEvents++;
      } else {
        processedEvents++;
        statements.push(env.CHAIN_DB.prepare('INSERT INTO events(id,block_number,body) VALUES(?,?,?)').bind(event.id, event.blockNumber, body));
      }
    }
    const next: ChainCursor = {
      blockNumber: to.toString(),
      blockHash: block.hash,
      updatedAt: new Date().toISOString()
    };
    statements.push(env.CHAIN_DB.prepare('UPDATE runtime SET cursor=?,fingerprint=? WHERE id=1 AND lease=?').bind(JSON.stringify(next), fingerprint(c), token));
    // Revalidate the retained ancestor after all preparation, immediately before commit.
    // This narrows the RPC/D1 race window; it is not consensus atomicity or finality.
    if (cursor) {
      const ancestor = await rpc.call<RpcBlock>('eth_getBlockByNumber', [hex(BigInt(cursor.blockNumber)), false]);
      if (ancestor.hash !== cursor.blockHash) return await halt(env, 'Canonical cursor mismatch');
    }
    await env.CHAIN_DB.batch(statements);
    r = {
      ...r,
      cursor: JSON.stringify(next)
    };
    return result(processedEvents, duplicateEvents);
  } finally {
    await env.CHAIN_DB.prepare('UPDATE runtime SET lease=NULL,lease_until=0 WHERE id=1 AND lease=?').bind(token).run();
  }
}

