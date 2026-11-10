import { decodeFunctionData, encodeEventTopics, encodeAbiParameters, encodeFunctionResult, keccak256, type Hex, type Abi } from 'viem';
import managerAbi from '../../contracts/abi/RetempoSubscriptionManager.json';
import escrowAbi from '../../contracts/abi/RetempoEscrow.json';
export const manager = '0x1111111111111111111111111111111111111111';
export const escrow = '0x2222222222222222222222222222222222222222';
export const merchant = '0x3333333333333333333333333333333333333333';
export const customer = '0x4444444444444444444444444444444444444444';
export const hash = (n: string) => keccak256(new TextEncoder().encode(n));
export const plan = hash('plan'),
  sub = hash('subscription');
export const settings = {
  APP_ENV: 'test',
  ARC_RPC_URL: 'http://127.0.0.1:8545',
  ARC_MANAGER_ADDRESS: manager,
  ARC_ESCROW_ADDRESS: escrow,
  ARC_START_BLOCK: '1'
};
export class Fixture {
  logs: Record<string, unknown>[] = [];
  receiptLogs?: Record<string, unknown>[];
  getters: Record<string, unknown> = {};
  badReceipt = false;
  badHash = false;
  calls: string[] = [];
  head = '0x1';
  transport: typeof fetch = async (input, init) => {
    const q = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    this.calls.push(q.method);
    let result: unknown;
    const block = {
      number: q.params[0],
      hash: this.badHash ? hash('changed') : hash(String(q.params[0])),
      timestamp: '0x6553f100'
    };
    switch (q.method) {
      case 'eth_chainId':
        result = '0x13b2';
        break;
      case 'eth_getCode':
        result = '0x60016000';
        break;
      case 'eth_blockNumber':
        result = this.head;
        break;
      case 'eth_getBlockByNumber':
        result = block;
        break;
      case 'eth_getLogs':
        result = this.logs;
        break;
      case 'eth_getTransactionReceipt':
        result = {
          status: this.badReceipt ? '0x0' : '0x1',
          transactionHash: q.params[0],
          blockNumber: '0x1',
          blockHash: hash('0x1'),
          transactionIndex: '0x0',
          logs: this.receiptLogs ?? this.logs
        };
        break;
      case 'eth_call':
        {
          const c = q.params[0] as {
            to: string;
            data: Hex;
          };
          if (c.data === '0x313ce567') {
            result = encodeAbiParameters([{
              type: 'uint8'
            }], [6]);
            break;
          }
          const abi = c.to === escrow ? escrowAbi : managerAbi;
          const names = ['usdc', 'escrow', 'manager'];
          let name = names.find(n => {
            try {
              return c.data.startsWith(keccak256(new TextEncoder().encode(n + '()')).slice(0, 10));
            } catch {
              return false;
            }
          });
          if (name) result = encodeAbiParameters([{
            type: 'address'
          }], [name === 'usdc' ? '0x3600000000000000000000000000000000000000' : name === 'escrow' ? escrow : manager]);else {
            const decoded = decodeFunctionData({
              abi: abi as Abi,
              data: c.data
            });
            if (!(decoded.functionName in this.getters)) throw Error('unhandled getter ' + decoded.functionName);
            result = encodeFunctionResult({
              abi: abi as Abi,
              functionName: decoded.functionName,
              result: this.getters[decoded.functionName]
            });
          }
          break;
        }
      default:
        throw Error('unhandled RPC ' + q.method);
    }
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result
    });
  };
}
export function paymentLog(sub: string, plan: string, amount = 9007199254740993n) {
  return {
    address: manager,
    blockNumber: '0x1',
    blockHash: hash('0x1'),
    transactionHash: hash('tx'),
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
    topics: encodeEventTopics({
      abi: managerAbi as Abi,
      eventName: 'SubscriptionPaymentProcessed',
      args: {
        subKey: sub,
        planKey: plan,
        customer
      }
    }),
    data: encodeAbiParameters([{
      type: 'uint32'
    }, {
      type: 'address'
    }, {
      type: 'uint128'
    }, {
      type: 'uint8'
    }, {
      type: 'bytes32'
    }, {
      type: 'uint40'
    }, {
      type: 'uint40'
    }, {
      type: 'bool'
    }], [1, merchant, amount, 0, hash('escrow'), 1700000000, 1702592000, false])
  };
}
export { managerAbi, escrowAbi, encodeFunctionResult };
export type { Abi };
