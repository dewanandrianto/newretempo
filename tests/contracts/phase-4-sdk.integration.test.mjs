import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { keccak256, stringToHex, encodeFunctionData } from 'viem'
import { RetempoClient } from '../../src/services/blockchain/client.ts'
import { startLocalArc } from '../helpers/arc-local.mjs'
const evidence = process.env.RETEMPO_EVIDENCE_DIR || 'docs/phase-4-evidence'

// Run with the pinned Bun --no-env-file: the actual TypeScript SDK is executed, not reimplemented.
void test('actual SDK executes finite mandates, renewed consent, recurring debit, manual renewal and cancellation on signed local Arc', { timeout: 120_000 }, async () => {
  const arc = await startLocalArc()
  const report = { scope: 'Production frontend SDK against fresh signed localhost Arc; artificial local balances and in-memory keys', passed: false, steps: [] }
  try {
    const sdk = account => new RetempoClient(arc.configuration, {
      account: account.address,
      reader: payload => arc.rpc(payload.method, payload.params ?? []),
      wallet: payload => arc.rpc(payload.method, payload.params ?? []),
      read: call => arc.client.readContract(call),
      simulate: async call => { await arc.client.simulateContract({ ...call, account: account.address }) },
      send: call => arc.signed(account, call.address, encodeFunctionData(call)),
      receipt: async hash => (await arc.confirm(hash)).status,
    })
    const writes = []
    const write = async (kind, send, receipt) => { const hash = await send(); assert.equal(await receipt(hash), 'success'); writes.push({ kind, hash }) }
    const merchant = sdk(arc.roles.merchant), customer = sdk(arc.roles.customer)
    const ref = keccak256(stringToHex('Explicit local SDK plan fixture'))
    const planKey = await arc.read(arc.manager, arc.managerAbi, 'planKey', [arc.roles.merchant.address, ref])
    const terms = { configuration: arc.configuration, planId: 'local-sdk-plan', externalRef: ref, planKey, merchant: arc.roles.merchant.address, payout: arc.roles.merchant.address, amount: '50000000', intervalSeconds: 2592000, trialSeconds: 0, graceSeconds: 0, vestDuration: 604800, arbitrator: arc.roles.arbitrator.address, customerMayRefundUnvested: true }
    await merchant.publishPlan(terms, write)
    const subRef = keccak256(stringToHex('Explicit local SDK subscription fixture'))
    const subscriptionKey = await arc.read(arc.manager, arc.managerAbi, 'subscriptionKey', [arc.roles.customer.address, subRef])
    const checkout = { id: 'local-sdk-checkout', status: 'open', expiresAt: new Date(Date.now() + 3600000).toISOString(), merchantName: 'Local SDK fixture', productName: 'Local SDK fixture', planName: 'Local SDK fixture', description: 'No external chain is used', amount: terms.amount, interval: 'month', intervalSeconds: terms.intervalSeconds, trialDays: 0, escrowDays: 7, planKey, merchant: terms.merchant, payout: terms.payout, arbitrator: terms.arbitrator, customerMayRefundUnvested: true, subscriptionId: 'local-sdk-subscription', invoiceId: 'local-sdk-invoice', configuration: arc.configuration, externalRef: subRef, subscriptionKey, customer: arc.roles.customer.address, paymentId: 'local-sdk-payment' }
    const previous = await customer.windows()
    await customer.subscribe(checkout, previous, write)
    assert.equal((await customer.getSubscription(subscriptionKey)).chargeCount, 1)
    const expiry = await customer.timestamp() + 90 * 86400
    await customer.createMandate(subscriptionKey, { perChargeCap: '50000000', totalCap: '150000000', expiry }, checkout, previous, write)
    assert.equal((await customer.getMandate(subscriptionKey)).active, true)
    assert.equal(await arc.read(arc.usdc, arc.tokenAbi, 'allowance', [arc.roles.customer.address, arc.manager]), 150000000n)
    const beforeChange = writes.length
    await arc.send(arc.roles.config, arc.escrow, arc.escrowAbi, 'setResponseWindow', [previous.responseWindow + 86400])
    const current = await customer.windows()
    await assert.rejects(customer.renew(subscriptionKey, checkout, previous, write), /windows changed/)
    await assert.rejects(customer.createMandate(subscriptionKey, { perChargeCap: '50000000', totalCap: '100000000', expiry }, checkout, current, write), /Accept current escrow terms/)
    assert.equal(writes.length, beforeChange, 'stale consent must fail before another approval or debit')
    await customer.acceptEscrowTerms(subscriptionKey, current, write)
    assert.equal((await customer.getMandate(subscriptionKey)).active, false, 'changed acceptance revokes the old mandate')
    await customer.createMandate(subscriptionKey, { perChargeCap: '50000000', totalCap: '100000000', expiry }, checkout, current, write)
    assert.equal(await arc.read(arc.usdc, arc.tokenAbi, 'allowance', [arc.roles.customer.address, arc.manager]), 100000000n)
    report.steps.push('Actual subscribe and finite 150-USDC mandate; changed windows reject before write; renewed consent revokes it; separate explicit 100-USDC mandate')
    await arc.rpc('evm_increaseTime', [2592001]); await arc.rpc('evm_mine')
    await arc.send(arc.roles.outsider, arc.manager, arc.managerAbi, 'charge', [subscriptionKey])
    assert.equal((await customer.getSubscription(subscriptionKey)).chargeCount, 2)
    assert.equal((await customer.getMandate(subscriptionKey)).spent, 50000000n)
    await customer.revokeMandate(subscriptionKey, write)
    assert.equal((await customer.getMandate(subscriptionKey)).active, false)
    await arc.rpc('evm_increaseTime', [2592001]); await arc.rpc('evm_mine')
    await customer.renew(subscriptionKey, checkout, current, write)
    assert.equal((await customer.getSubscription(subscriptionKey)).chargeCount, 3)
    assert.equal((await customer.getMandate(subscriptionKey)).spent, 50000000n, 'manual renewal does not consume a revoked mandate budget')
    await merchant.cancelSubscription(subscriptionKey, write)
    assert.equal((await customer.getSubscription(subscriptionKey)).status, 2)
    report.steps.push('Permissionless real recurring charge spends exactly 50 USDC; revoke; separate manual renewal; actual merchant cancellation')
    report.signedTransactions = arc.receipts.slice(5).map(receipt => receipt.transactionHash)
    report.sdkWrites = writes
    report.passed = true
    console.log(JSON.stringify({ passed: true, signedTransactions: report.signedTransactions.length, sdkWrites: writes.length, steps: report.steps.length }))
  } finally {
    await arc.stop()
    report.nodeStopped = arc.stopped
    await mkdir(evidence, { recursive: true })
    await writeFile(path.join(evidence, 'signed-sdk-integration.json'), JSON.stringify(report, null, 2) + '\n')
  }
})
