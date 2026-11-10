import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker, { handle } from '../src/service';
import { Fixture, settings, hash } from './fixtures';
it('verifies configured chain, code, token and reciprocal link before exposing wallet proofs', async () => {
  const f = new Fixture();
  const r = await handle(new Request('https://private/v1/config'), {
    ...env,
    ...settings
  } as never, f.transport);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({
    configured: true,
    mode: 'local',
    genesisHash: hash('0x0')
  });
  expect(f.calls).toContain('eth_call');
});
import { actorKey, reference } from '../src/bindings';
import { merchant, customer } from './fixtures';
const req = (path: string, body: unknown) => new Request('https://private/v1/' + path, {
  method: 'POST',
  body: JSON.stringify(body)
});
it('persists immutable server-derived plan bindings, rejecting wrong key and cross-tenant reuse', async () => {
  const f = new Fixture(),
    e = {
      ...env,
      ...settings
    } as never;
  const binding = {
    orgId: 'org-bind',
    kind: 'plan',
    recordId: 'plan-bind',
    key: actorKey(merchant, reference('org-bind', 'plan', 'plan-bind')),
    merchant
  };
  expect((await handle(req('bind', {
    ...binding,
    key: hash('forged')
  }), e, f.transport)).status).toBe(400);
  expect((await handle(req('bind', binding), e, f.transport)).status).toBe(200);
  expect((await handle(req('bind', binding), e, f.transport)).status).toBe(200);
  expect((await handle(req('bind', {
    ...binding,
    merchant: customer
  }), e, f.transport)).status).not.toBe(200);
  const snapshot = (await (await handle(req('snapshot', {
    orgId: 'org-bind'
  }), e, f.transport)).json()) as {
    bindings: unknown[];
  };
  expect(snapshot.bindings).toEqual([binding]);
  const other = (await (await handle(req('snapshot', {
    orgId: 'other'
  }), e, f.transport)).json()) as {
    bindings: unknown[];
  };
  expect(other.bindings).toEqual([]);
});
describe('private service', () => {
  it('stays disabled without deployment and rejects caller authority', async () => {
    const e = env as unknown as Parameters<typeof worker.fetch>[1];
    const r = await worker.fetch(new Request('https://private/v1/config'), e);
    expect(await r.json()).toMatchObject({
      configured: false,
      mode: 'disabled',
      manager: null
    });
    const s = await worker.fetch(new Request('https://private/v1/sync', {
      method: 'POST',
      body: JSON.stringify({
        events: [],
        rpcUrl: 'https://evil'
      })
    }), e);
    expect(s.status).toBe(400);
  });
});
