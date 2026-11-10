import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi } from 'viem';
import { handle, type Env } from '../src/service';
import { Fixture, settings, hash, merchant, customer, escrow, escrowAbi } from './fixtures';
import { actorKey, reference, chargeReference } from '../src/bindings';
import type { ChainSnapshot } from '../../shared/chain';
const req = (path: string, body: unknown) => new Request('https://private/v1/' + path, {
  method: 'POST',
  body: JSON.stringify(body)
});
it('does not double refund on resolution and omits ambiguous wallet-wide withdrawals from tenant events and ledger', async () => {
  const f = new Fixture(),
    e = {
      ...env,
      ...settings
    } as unknown as Env,
    orgId = 'org-escrow';
  const planKey = actorKey(merchant, reference(orgId, 'plan', 'plan')),
    subKey = actorKey(customer, reference(orgId, 'subscription', 'sub')),
    key = actorKey(merchant, chargeReference(subKey, '1'));
  for (const b of [{
    orgId,
    kind: 'plan',
    recordId: 'plan',
    key: planKey,
    merchant
  }, {
    orgId,
    kind: 'subscription',
    recordId: 'sub',
    key: subKey,
    merchant,
    customer,
    planKey
  }, {
    orgId,
    kind: 'escrow',
    recordId: 'escrow',
    key,
    merchant,
    customer,
    planKey,
    subscriptionKey: subKey,
    chargeNumber: '1',
    amount: '1000000'
  }]) expect((await handle(req('bind', b), e, f.transport)).status).toBe(200);
  const event = (name: string, args: Record<string, unknown>, i: number) => {
    const abi = escrowAbi as Abi;
    const def = abi.find(d => d.type === 'event' && d.name === name)!;
    if (def.type !== 'event') throw Error('fixture ABI');
    const fields = def.inputs.filter(d => !d.indexed);
    return {
      address: escrow,
      blockNumber: '0x1',
      blockHash: hash('0x1'),
      transactionHash: hash('tx-escrow'),
      transactionIndex: '0x0',
      logIndex: '0x' + i.toString(16),
      removed: false,
      topics: encodeEventTopics({
        abi,
        eventName: name,
        args
      }),
      data: encodeAbiParameters(fields, fields.map(d => args[d.name!]))
    };
  };
  f.logs = [event('EscrowFunded', {
    escrowKey: key,
    payer: customer,
    amount: 1000000n,
    vestStart: 1700000000,
    vestEnd: 1700086400,
    viaManager: true
  }, 0), event('RefundCredited', {
    escrowKey: key,
    customer,
    amount: 600000n,
    reason: 3,
    totalRefunded: 600000n
  }, 1), event('DisputeResolved', {
    escrowKey: key,
    arbitrator: merchant,
    merchantAmount: 400000n,
    customerAmount: 600000n,
    rulingHash: hash('ruling')
  }, 2), event('Withdrawn', {
    account: customer,
    to: customer,
    amount: 600000n
  }, 3)];
  f.getters.balanceOf = 0n;
  f.getters.claimableAmount = 0n;
  f.getters.getPlan = {
    merchant,
    payout: merchant,
    amount: 1000000n,
    interval: 2592000,
    trial: 0,
    grace: 0,
    vestDuration: 86400,
    arbitrator: merchant,
    customerMayRefundUnvested: true,
    active: true
  };
  f.getters.getSubscription = {
    customer,
    planKey,
    amount: 1000000n,
    interval: 2592000,
    grace: 0,
    nextChargeAt: 1702592000,
    chargeCount: 1,
    acceptedArbitrator: merchant,
    status: 1
  };
  f.getters.getMandate = {
    perChargeCap: 0n,
    totalCap: 0n,
    spent: 0n,
    expiry: 0,
    nonce: 0,
    active: false
  };
  f.getters.getEscrow = {
    merchant,
    customer,
    arbitrator: merchant,
    amount: 1000000n,
    claimed: 0n,
    awarded: 400000n,
    refunded: 600000n,
    frozen: 0n,
    carvedVested: 0n,
    vestStart: 1700000000,
    vestDuration: 86400,
    responseWindow: 86400,
    resolutionTimeout: 604800,
    disputedAt: 1700000010,
    customerMayRefundUnvested: true,
    merchantResponded: true,
    status: 3,
    dispute: 2,
    outcome: 3,
    settlementId: 0,
    settlementProposer: merchant,
    settlementMerchantAmount: 0n,
    settlementScope: 0n,
    replacementProposer: merchant,
    replacementCandidate: merchant
  };
  expect((await handle(req('sync', {}), e, f.transport)).status).toBe(200);
  const r = await handle(req('snapshot', {
    orgId
  }), e, f.transport);
  expect(r.status).toBe(200);
  const s = (await r.json()) as ChainSnapshot;
  expect(s.events.map(e => e.name)).not.toContain('Withdrawn');
  const ledger = s.projections.filter(p => p.kind === 'ledger');
  expect(ledger).toHaveLength(2);
  expect(ledger.find(p => p.values.kind === 'refund')).toMatchObject({
    values: {
      amount: '600000',
      direction: 'out',
      counterparty: customer,
      createdAt: '2023-11-14T22:13:20.000Z'
    }
  });
  expect(ledger.find(p => p.values.kind === 'award')).toMatchObject({
    values: {
      amount: '400000',
      direction: 'in'
    }
  });
  expect(s.projections.find(p => p.kind === 'escrow')).toMatchObject({
    values: {
      balance: '0',
      claimable: '0',
      frozen: '0'
    }
  });
  expect(s.projections.find(p => p.kind === 'dispute')).toMatchObject({
    state: 'resolved',
    values: {
      refunded: '600000',
      awarded: '400000',
      status: 'closed',
      dispute: 'resolved',
      outcome: 'resolved',
      respondBy: '2023-11-15T22:13:30.000Z'
    }
  });
});
