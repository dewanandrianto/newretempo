import assert from 'node:assert/strict'
import test from 'node:test'
import { startLocalArc } from '../helpers/arc-local.mjs'

test('Phase 4 fixture owns a fresh signed Arc deployment and stops its node', { timeout: 90_000 }, async () => {
  const fixture = await startLocalArc()
  try {
    assert.equal(new URL(fixture.url).hostname, '127.0.0.1')
    assert.equal(await fixture.client.getChainId(), 5042)
    assert.equal(fixture.configuration.configured, true)
    assert.equal(fixture.configuration.mode, 'local')
    assert.match(fixture.configuration.genesisHash, /^0x[0-9a-f]{64}$/i)
    assert.match(fixture.configuration.managerCodeHash, /^0x[0-9a-f]{64}$/i)
    assert.match(fixture.configuration.escrowCodeHash, /^0x[0-9a-f]{64}$/i)
    assert.equal((await fixture.read(fixture.manager, fixture.managerAbi, 'escrow')).toLowerCase(), fixture.escrow.toLowerCase())
    assert.equal((await fixture.read(fixture.escrow, fixture.escrowAbi, 'manager')).toLowerCase(), fixture.manager.toLowerCase())
    assert.equal(await fixture.read(fixture.manager, fixture.managerAbi, 'paused'), false)
    assert.equal(await fixture.read(fixture.escrow, fixture.escrowAbi, 'paused'), false)
    assert.equal(await fixture.read(fixture.usdc, fixture.tokenAbi, 'decimals'), 6)
    assert.equal(await fixture.read(fixture.escrow, fixture.escrowAbi, 'isArbitrator', [fixture.roles.arbitrator.address]), true)
    assert.equal(fixture.receipts.length, 5)
    assert.ok(fixture.receipts.every(receipt => receipt.status === 'success'))
    console.log(JSON.stringify({ scope: 'Fresh loopback-only local Arc fixture', manager: fixture.manager, escrow: fixture.escrow, signedReceipts: fixture.receipts.length, sourceFingerprints: Object.keys(fixture.sourceFingerprints).length }))
  } finally {
    await fixture.stop()
  }
  assert.equal(fixture.stopped, true)
})
