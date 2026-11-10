import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { build as buildFrontend } from 'vite'
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare'
import { readD1Migrations } from '@cloudflare/vitest-plugin'
import { startLocalArc, freePort } from '../helpers/arc-local.mjs'
import { checkoutInBrowser, merchantPublishAndCheckout, renewalInvoiceInBrowser, renewalPaymentInBrowser } from '../helpers/checkout-browser.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const evidence = process.env.RETEMPO_EVIDENCE_DIR || path.join(root, 'docs/phase-4-evidence')
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2)

test('signed local Arc, public/private Workers and isolated persistent D1 complete an actual subscription escrow lifecycle', { timeout: 240_000 }, async () => {
  const arc = await startLocalArc()
  let mf
  const report = { scope: 'Fresh non-forked loopback Arc and two real workerd Workers; in-memory keys and artificial local balances only', passed: false, steps: [], chainTransactions: [] }
  try {
    await mkdir(evidence, { recursive: true })
    const browserEnabled = process.env.RETEMPO_BROWSER === '1'
    const clientDirectory = path.join(arc.directory, 'client')
    if (browserEnabled) await buildFrontend({ root, logLevel: 'error', build: { outDir: clientDirectory, emptyOutDir: true } })
    const assets = async request => {
      const pathname = new URL(request.url).pathname
      const filename = path.resolve(clientDirectory, `.${pathname}`)
      if (!filename.startsWith(clientDirectory + path.sep)) return new Response('Not found', { status: 404 })
      let content, extension = path.extname(filename)
      try { content = await readFile(filename) } catch (error) {
        if (!['ENOENT', 'EISDIR'].includes(error.code)) throw error
        if (extension) return new Response('Not found', { status: 404 })
        content = await readFile(path.join(clientDirectory, 'index.html')); extension = '.html'
      }
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff' }
      return new Response(content, { headers: { 'content-type': mime[extension] ?? 'application/octet-stream' } })
    }
    const bundles = path.join(arc.directory, 'bundles')
    await build({ entryPoints: { public: path.join(root, 'worker/src/index.ts'), chain: path.join(root, 'chain-worker/src/index.ts') }, outdir: bundles, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*', 'node:*'], logLevel: 'silent' })
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const options = { rootPath: bundles, host: '127.0.0.1', port, log: new Log(LogLevel.ERROR), resourcePersistencePath: path.join(arc.directory, 'state'), workers: [
      { name: 'retempo', modules: true, scriptPath: path.join(bundles, 'public.js'), compatibilityDate: '2026-11-08', d1Databases: { DB: 'retempo-phase4-public' }, serviceBindings: { CHAIN: 'retempo-chain', ...(browserEnabled ? { ASSETS: assets } : {}) }, bindings: { APP_ENV: 'test', SESSION_SECRET: randomBytes(32).toString('hex'), APP_ORIGINS: base, SIWE_DOMAIN: `127.0.0.1:${port}`, SIWE_URI: base, SIWE_CHAIN_ID: '5042', EMAIL_MODE: 'disabled', COOKIE_SECURE: 'false', REQUIRE_VERIFIED_EMAIL: 'false' } },
      { name: 'retempo-chain', modules: true, scriptPath: path.join(bundles, 'chain.js'), compatibilityDate: '2026-11-08', d1Databases: { CHAIN_DB: 'retempo-phase4-private' }, bindings: { APP_ENV: 'test', ARC_RPC_URL: arc.url, ARC_MANAGER_ADDRESS: arc.manager, ARC_ESCROW_ADDRESS: arc.escrow, ARC_START_BLOCK: arc.configuration.startBlock } },
    ] }
    const boot = async () => { mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready }
    await boot()
    for (const [binding, worker, migrations] of [['DB', 'retempo', 'worker/migrations'], ['CHAIN_DB', 'retempo-chain', 'chain-worker/migrations']]) {
      const db = await mf.getD1Database(binding, worker)
      for (const migration of await readD1Migrations(path.join(root, migrations))) await db.batch(migration.queries.map(query => db.prepare(query)))
    }
    const session = () => {
      const cookies = new Map()
      const request = async (route, data, status = 200, method = data === undefined ? 'GET' : 'POST') => {
        const response = await fetch(base + route, { method, headers: { Origin: base, 'X-Requested-With': 'retempo', ...(data !== undefined ? { 'content-type': 'application/json' } : {}), Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) })
        for (const line of response.headers.getSetCookie()) { const item = line.split(';')[0]; const index = item.indexOf('='); cookies.set(item.slice(0, index), item.slice(index + 1)) }
        const body = await response.json()
        assert.equal(response.status, status, `${method} ${route.split('/').slice(0, 5).join('/')}: ${json(body).slice(0, 1500)}`)
        return body
      }
      return { request, cookies }
    }
    const merchant = session(), customer = session(), outsider = session()
    const authenticate = async (client, account) => { const challenge = await client.request('/api/auth/siwe/nonce', { address: account.address }); await client.request('/api/auth/siwe/verify', { message: challenge.message, signature: await account.signMessage({ message: challenge.message }) }) }
    await authenticate(merchant, arc.roles.merchant)
    await authenticate(customer, arc.roles.customer)
    await authenticate(outsider, arc.roles.outsider)
    report.steps.push('Three independent real SIWE wallet sessions')
    const config = await merchant.request('/api/chain/config')
    assert.equal(config.genesisHash, arc.configuration.genesisHash)
    assert.equal(config.managerCodeHash, arc.configuration.managerCodeHash)
    assert.equal(config.escrowCodeHash, arc.configuration.escrowCodeHash)
    const suffix = randomBytes(4).toString('hex')
    const org = await merchant.request('/api/orgs', { name: 'Phase 4 Local Merchant', slug: `phase4-${suffix}`, country: 'US', industry: 'Software' }, 201)
    const prefix = `/api/orgs/${org.id}`
    const product = await merchant.request(prefix + '/products', { name: 'Verified Local Service', description: 'Actual isolated local acceptance' }, 201)
    const plan = await merchant.request(prefix + '/plans', { productId: product.id, name: 'Verified Escrow Plan', amount: '100000000', interval: 'month', trialDays: 0, escrowDays: 7 }, 201)
    const buyer = await merchant.request(prefix + '/customers', { name: 'Local customer', email: `local-${suffix}@example.test` }, 201)
    await merchant.request(prefix + '/wallets', { purpose: 'customer', address: arc.roles.customer.address, customerId: buyer.id, label: 'Verified local participant' }, 201)
    const sub = await merchant.request(prefix + '/subscriptions', { planId: plan.id, customerId: buyer.id }, 201)
    const preparedPlan = await merchant.request(prefix + `/chain/plans/${plan.id}/prepare`, { wallet: arc.roles.merchant.address, payout: arc.roles.merchant.address, arbitrator: arc.roles.arbitrator.address, customerMayRefundUnvested: true, graceSeconds: 0 })
    let merchantBrowser
    if (browserEnabled) {
      merchantBrowser = await merchantPublishAndCheckout({ base, arc, merchantCookies: merchant.cookies, planId: plan.id, subscriptionId: sub.id, evidence })
      report.merchantBrowser = { signedWalletRequests: merchantBrowser.signedWalletRequests, capabilityCreatedThroughUI: true }
    } else await arc.send(arc.roles.merchant, arc.manager, arc.managerAbi, 'createPlan', [preparedPlan.externalRef, preparedPlan.payout, BigInt(preparedPlan.amount), preparedPlan.intervalSeconds, preparedPlan.trialSeconds, preparedPlan.graceSeconds, preparedPlan.vestDuration, preparedPlan.arbitrator, preparedPlan.customerMayRefundUnvested])
    const planReceipt = arc.receipts[arc.receipts.length - 1]
    report.chainTransactions.push(planReceipt.transactionHash)
    await merchant.request('/api/chain/sync', {})
    const initial = await merchant.request(prefix + '/chain/snapshot')
    assert.ok(initial.projections.some(row => row.kind === 'plan' && row.recordId === plan.id && row.state === 'active'))
    const link = merchantBrowser ?? await merchant.request(prefix + '/chain/checkouts', { subscriptionId: sub.id }, 201)
    await outsider.request(`/api/public/checkouts/${link.token}/prepare`, { wallet: arc.roles.outsider.address }, 403)
    const checkout = await customer.request(`/api/public/checkouts/${link.token}/prepare`, { wallet: arc.roles.customer.address })
    const repeat = await customer.request(`/api/public/checkouts/${link.token}/prepare`, { wallet: arc.roles.customer.address })
    assert.equal(repeat.paymentId, checkout.paymentId)
    assert.equal(repeat.escrowId, checkout.escrowId)
    const before = await merchant.request(prefix + '/payments')
    assert.equal(before.find(row => row.id === checkout.paymentId).status, 'pending')
    report.steps.push('Server-derived immutable plan and charge bindings; wrong customer denied; stable preparation replay')
    if (browserEnabled) report.browser = await checkoutInBrowser({ base, arc, token: link.token, escrowId: checkout.escrowId, customerCookies: customer.cookies, merchantCookies: merchant.cookies, evidence })
    else {
      await arc.send(arc.roles.customer, arc.usdc, arc.tokenAbi, 'approve', [arc.manager, BigInt(checkout.amount)])
      await arc.send(arc.roles.customer, arc.manager, arc.managerAbi, 'subscribe', [checkout.externalRef, checkout.planKey, checkout.arbitrator])
    }
    const funded = arc.receipts[arc.receipts.length - 1]
    report.chainTransactions.push(funded.transactionHash)
    await merchant.request('/api/chain/sync', {})
    const payments = await merchant.request(prefix + '/payments')
    assert.equal(payments.find(row => row.id === checkout.paymentId).status, 'succeeded')
    assert.equal((await merchant.request(prefix + '/invoices')).find(row => row.id === checkout.invoiceId).status, 'paid')
    assert.equal((await merchant.request(prefix + '/subscriptions')).find(row => row.id === sub.id).status, 'active')
    const paid = await customer.request(`/api/public/checkouts/${link.token}`)
    assert.equal(paid.status, 'complete')
    const state = await merchant.request(prefix + '/chain/snapshot')
    const escrow = state.projections.find(row => row.kind === 'escrow' && row.recordId === checkout.escrowId)
    assert.equal(escrow.values.balance, checkout.amount)
    assert.equal(await arc.read(arc.usdc, arc.tokenAbi, 'allowance', [arc.roles.customer.address, arc.manager]), 0n)
    const rawDB = await mf.getD1Database('DB', 'retempo')
    assert.equal((await rawDB.prepare('SELECT status FROM payments WHERE id=?').bind(checkout.paymentId).first()).status, 'pending')
    assert.equal((await rawDB.prepare('SELECT status FROM invoices WHERE id=?').bind(checkout.invoiceId).first()).status, 'open')
    report.steps.push('Actual signed approval and debit; only private verified projections declare payment, invoice and subscription settled')
    const eventCount = state.events.length
    await mf.dispose()
    await boot()
    await merchant.request('/api/chain/sync', {})
    const reloaded = await merchant.request(prefix + '/chain/snapshot')
    assert.equal(reloaded.events.length, eventCount)
    assert.equal(reloaded.projections.filter(row => row.kind === 'payment' && row.recordId === checkout.paymentId && row.state === 'paid').length, 1)
    report.steps.push('Both Worker processes restarted; D1 sessions/bindings/cursor/events survive; replay creates no duplicate payment')
    if (process.env.RETEMPO_COLD_RECOVERY === '1') {
      // A real cold-copy recovery of our disposable local state, NOT Cloudflare Time Travel.
      await mf.dispose()
      const backup = path.join(arc.directory, 'cold-backup')
      const restored = path.join(arc.directory, 'cold-restored')
      await cp(options.resourcePersistencePath, backup, { recursive: true })
      await cp(backup, restored, { recursive: true })
      options.resourcePersistencePath = restored
      await boot()
      const recovered = await merchant.request(prefix + '/chain/snapshot')
      assert.deepEqual(recovered.events.map(row => row.id), reloaded.events.map(row => row.id))
      assert.equal((await merchant.request(prefix + '/payments')).find(row => row.id === checkout.paymentId).status, 'succeeded')
      assert.equal(recovered.cursor.blockHash, reloaded.cursor.blockHash)
      report.coldRecovery = { mode: 'Disposed both Workers, copied local persisted state to backup and a new restore directory, restarted against restored state', cloudflareTimeTravelTested: false, events: recovered.events.length, canonicalCursorPreserved: true, authenticatedSessionPreserved: true }
      report.steps.push('Paired local D1 cold backup/restore preserves exact canonical events, cursor, verified payment and authenticated session')
    }
    const plan2 = await merchant.request(prefix + '/plans', { productId: product.id, name: 'Disputed Escrow Plan', amount: '100000000', interval: 'month', trialDays: 0, escrowDays: 7 }, 201)
    const terms2 = await merchant.request(prefix + `/chain/plans/${plan2.id}/prepare`, { wallet: arc.roles.merchant.address, payout: arc.roles.merchant.address, arbitrator: arc.roles.arbitrator.address, customerMayRefundUnvested: true, graceSeconds: 0 })
    await arc.send(arc.roles.merchant, arc.manager, arc.managerAbi, 'createPlan', [terms2.externalRef, terms2.payout, BigInt(terms2.amount), terms2.intervalSeconds, terms2.trialSeconds, terms2.graceSeconds, terms2.vestDuration, terms2.arbitrator, terms2.customerMayRefundUnvested])
    await merchant.request('/api/chain/sync', {})
    const sub2 = await merchant.request(prefix + '/subscriptions', { planId: plan2.id, customerId: buyer.id }, 201)
    const link2 = await merchant.request(prefix + '/chain/checkouts', { subscriptionId: sub2.id }, 201)
    const checkout2 = await customer.request(`/api/public/checkouts/${link2.token}/prepare`, { wallet: arc.roles.customer.address })
    await arc.send(arc.roles.customer, arc.usdc, arc.tokenAbi, 'approve', [arc.manager, BigInt(checkout2.amount)])
    await arc.send(arc.roles.customer, arc.manager, arc.managerAbi, 'subscribe', [checkout2.externalRef, checkout2.planKey, checkout2.arbitrator])
    await customer.request('/api/chain/sync', {})
    const secondState = await merchant.request(prefix + '/chain/snapshot')
    const secondEscrow = secondState.projections.find(row => row.kind === 'escrow' && row.recordId === checkout2.escrowId)
    await arc.send(arc.roles.customer, arc.escrow, arc.escrowAbi, 'openDispute', [secondEscrow.key, 100000000n, `0x${'12'.repeat(32)}`])
    await arc.send(arc.roles.merchant, arc.escrow, arc.escrowAbi, 'respondToDispute', [secondEscrow.key, `0x${'34'.repeat(32)}`])
    await arc.send(arc.roles.arbitrator, arc.escrow, arc.escrowAbi, 'resolveDispute', [secondEscrow.key, 40000000n, `0x${'56'.repeat(32)}`])
    await customer.request('/api/chain/sync', {})
    const resolved = await merchant.request(prefix + '/chain/snapshot')
    assert.ok(resolved.projections.some(row => row.kind === 'dispute' && row.recordId === checkout2.escrowId && row.state === 'resolved'))
    assert.equal(await arc.read(arc.escrow, arc.escrowAbi, 'withdrawableOf', [arc.roles.customer.address]), 60000000n)
    await arc.rpc('evm_increaseTime', [7 * 86400 + 1])
    await arc.rpc('evm_mine')
    await arc.send(arc.roles.merchant, arc.escrow, arc.escrowAbi, 'claim', [escrow.key])
    await customer.request('/api/chain/sync', {})
    const claimed = await merchant.request(prefix + '/chain/snapshot')
    assert.equal(claimed.projections.find(row => row.kind === 'escrow' && row.recordId === checkout.escrowId).values.balance, '0')
    assert.equal(await arc.read(arc.escrow, arc.escrowAbi, 'withdrawableOf', [arc.roles.merchant.address]), 140000000n)
    await arc.send(arc.roles.merchant, arc.escrow, arc.escrowAbi, 'withdraw', [arc.roles.merchant.address])
    await arc.send(arc.roles.customer, arc.escrow, arc.escrowAbi, 'setPayoutAddress', [arc.roles.payout.address])
    const payoutBefore = await arc.client.getBalance({ address: arc.roles.payout.address })
    await arc.send(arc.roles.outsider, arc.escrow, arc.escrowAbi, 'withdrawToPayout', [arc.roles.customer.address])
    assert.equal(await arc.client.getBalance({ address: arc.roles.payout.address }), payoutBefore + 60000000n * 10n ** 12n)
    await outsider.request('/api/chain/sync', {})
    const walletProof = await customer.request(`/api/wallet/chain/snapshot?wallet=${arc.roles.customer.address}`)
    assert.ok(walletProof.events.some(row => row.name === 'Withdrawn' && row.args.amount === '60000000'))
    assert.ok(walletProof.projections.some(row => row.kind === 'wallet' && row.recordId === arc.roles.customer.address.toLowerCase() && row.values.eventName === 'Withdrawn'))
    await outsider.request(`/api/wallet/chain/snapshot?wallet=${arc.roles.customer.address}`, undefined, 403)
    const final = await merchant.request(prefix + '/chain/snapshot')
    assert.equal(final.events.some(row => row.name === 'Withdrawn'), false, 'Wallet-wide withdrawals are not allocated into organization revenue')
    assert.equal(await arc.read(arc.escrow, arc.escrowAbi, 'totalLocked'), 0n)
    assert.equal(await arc.read(arc.escrow, arc.escrowAbi, 'totalWithdrawable'), 0n)
    if (browserEnabled) {
      await arc.rpc('evm_increaseTime', [2592001]); await arc.rpc('evm_mine')
      const renewal = await renewalInvoiceInBrowser({ base, arc, merchantCookies: merchant.cookies, subscriptionId: sub.id, evidence })
      const renewalWrites = await renewalPaymentInBrowser({ base, arc, token: renewal.token, customerCookies: customer.cookies })
      const renewed = await merchant.request(prefix + '/chain/snapshot')
      assert.ok(renewed.projections.some(row => row.kind === 'invoice' && row.recordId === renewal.invoiceId && row.state === 'paid'))
      assert.equal(renewed.projections.find(row => row.kind === 'subscription' && row.recordId === sub.id).values.chargeCount, '2')
      const renewalBinding = renewed.bindings.find(row => row.kind === 'escrow' && row.subscriptionKey === checkout.subscriptionKey && row.chargeNumber === '2')
      assert.ok(renewalBinding, 'renewal escrow is immutably bound to the exact second charge')
      const renewalEscrow = renewed.projections.find(row => row.kind === 'escrow' && row.recordId === renewalBinding.recordId && row.values.balance === '100000000')
      assert.ok(renewalEscrow, 'renewal has its own real funded escrow')
      await arc.rpc('evm_increaseTime', [604801]); await arc.rpc('evm_mine')
      await arc.send(arc.roles.merchant, arc.escrow, arc.escrowAbi, 'claim', [renewalEscrow.key])
      await arc.send(arc.roles.merchant, arc.escrow, arc.escrowAbi, 'withdraw', [arc.roles.merchant.address])
      await outsider.request('/api/chain/sync', {})
      assert.equal(await arc.read(arc.escrow, arc.escrowAbi, 'totalLocked'), 0n)
      assert.equal(await arc.read(arc.escrow, arc.escrowAbi, 'totalWithdrawable'), 0n)
      const exactPeriod = await (await mf.getD1Database('DB', 'retempo')).prepare('SELECT period_start FROM invoices WHERE id=?').bind(renewal.invoiceId).first()
      assert.equal(exactPeriod.period_start, renewal.periodStart)
      report.renewalBrowser = { invoiceId: renewal.invoiceId, exactPeriodStart: renewal.periodStart, signedWalletRequests: renewalWrites }
      report.steps.push('Real merchant renewal invoice creation/finalization/capability, exact UTC period, customer browser renewal, new paid charge and settled escrow')
    }
    report.chainTransactions = arc.receipts.slice(5).map(receipt => receipt.transactionHash)
    report.steps.push('Second real charge, customer dispute, merchant response, arbitrator split and pinned private dispute state')
    report.steps.push('Vested claim, actual merchant withdrawal and permissionless fixed-payout customer recovery; gas-independent recipient balance exact')
    report.steps.push('Wallet proof restricted to SIWE owner; organization history excludes unallocated wallet-wide withdrawals; final liabilities zero')
    report.records = { orgId: org.id, subscriptionId: sub.id, paymentId: checkout.paymentId, escrowId: checkout.escrowId, invoiceId: checkout.invoiceId }
    report.replayBaselineEvents = eventCount
    report.canonicalEvents = (await merchant.request(prefix + '/chain/snapshot')).events.length
    report.passed = true
    console.log(json({ passed: true, browser: browserEnabled, steps: report.steps.length, canonicalEvents: report.canonicalEvents, signedApplicationTransactions: report.chainTransactions.length }))
  } catch (error) {
    report.failure = error.message
    throw error
  } finally {
    if (mf) await mf.dispose()
    await arc.stop()
    report.nodeStopped = arc.stopped
    await mkdir(evidence, { recursive: true })
    await writeFile(path.join(evidence, 'signed-worker-integration.json'), json(report) + '\n')
  }
})
