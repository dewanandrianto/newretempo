import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.RETEMPO_PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.RETEMPO_WORKER_URL || 'http://127.0.0.1:8787'
const evidence = process.env.RETEMPO_SMOKE_EVIDENCE_DIR

test('actual local Wrangler, D1, wallet authentication, merchant records, and frontend work together', { timeout: 120000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.RETEMPO_CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const headers = { Origin: base, 'X-Requested-With': 'retempo' }
  const steps = []
  const post = (url, data, extra = {}) => context.request.post(base + url, { data, headers: { ...headers, ...extra } })
  const get = (url) => context.request.get(base + url)
  async function expectStatus(response, status, step) {
    assert.equal(response.status(), status, `${step}: expected ${status}, got ${response.status()}`)
    steps.push({ step, status })
    return response
  }
  try {
    const health = await expectStatus(await get('/api/health'), 200, 'Worker and D1 health')
    assert.equal((await health.json()).database, 'd1')
    await expectStatus(await get('/api/orgs'), 401, 'Anonymous tenant access denied')
    await expectStatus(await post('/api/auth/register', { email: 'unconfigured@example.test', password: 'a generated local fixture password 941', name: 'Not Created' }), 503, 'Unconfigured email fails closed')

    // Throwaway signing key exists only in memory. No transaction or RPC call is sent.
    const account = privateKeyToAccount(generatePrivateKey())
    const challengeResponse = await expectStatus(await post('/api/auth/siwe/nonce', { address: account.address }), 200, 'Server-issued SIWE challenge')
    const challenge = await challengeResponse.json()
    const signature = await account.signMessage({ message: challenge.message })
    await expectStatus(await post('/api/auth/siwe/verify', { message: challenge.message, signature }), 200, 'Local signature authentication')
    await expectStatus(await post('/api/auth/siwe/verify', { message: challenge.message, signature }), 401, 'SIWE replay denied')
    const suffix = crypto.randomUUID().slice(0, 8)
    const organization = await (await expectStatus(await post('/api/orgs', { name: 'Local Smoke Merchant', slug: `smoke-${suffix}`, industry: 'Software', country: 'US' }), 201, 'Create persistent organization')).json()
    const root = `/api/orgs/${organization.id}`
    const productName = `Verified Product ${suffix}`
    const product = await (await expectStatus(await post(root + '/products', { name: productName, description: 'Local acceptance fixture' }), 201, 'Create product')).json()
    const plan = await (await expectStatus(await post(root + '/plans', { productId: product.id, name: 'Exact Plan', amount: '9007199254740993', interval: 'month', trialDays: 0, escrowDays: 7 }), 201, 'Create exact-amount plan')).json()
    assert.equal(plan.amount, '9007199254740993')
    const customer = await (await expectStatus(await post(root + '/customers', { name: 'Local Test Customer', email: `customer-${suffix}@example.test` }), 201, 'Create customer')).json()
    await expectStatus(await post(root + '/subscriptions', { customerId: customer.id, planId: plan.id }), 201, 'Create incomplete subscription record')
    const key = `smoke-invoice-${suffix}`
    const body = { customerId: customer.id, dueAt: new Date(Date.now() + 86400000).toISOString(), lineItems: [{ description: 'Exact units', quantity: 1, unitAmount: '9007199254740993' }] }
    const invoice = await (await expectStatus(await post(root + '/invoices', body, { 'Idempotency-Key': key }), 201, 'Create invoice')).json()
    assert.equal(invoice.total, '9007199254740993')
    const replay = await (await expectStatus(await post(root + '/invoices', body, { 'Idempotency-Key': key }), 200, 'Idempotent invoice replay')).json()
    assert.equal(replay.id, invoice.id)
    await expectStatus(await post(`${root}/invoices/${invoice.id}/finalize`, {}), 200, 'Finalize invoice')
    const payment = await (await expectStatus(await post(root + '/payments', { invoiceId: invoice.id }, { 'Idempotency-Key': `smoke-payment-${suffix}` }), 201, 'Create pending payment record')).json()
    assert.equal(payment.status, 'pending')
    assert.equal(payment.amount, invoice.total)
    const escrow = await (await expectStatus(await post(root + '/escrows', { invoiceId: invoice.id, releaseAfterDays: 7 }, { 'Idempotency-Key': `smoke-escrow-${suffix}` }), 201, 'Create unfunded escrow record')).json()
    assert.equal(escrow.status, 'pending_funding')
    assert.equal(escrow.amount, invoice.total)

    await page.goto(base + '/app/products', { waitUntil: 'networkidle' })
    await page.getByText(productName, { exact: true }).first().waitFor()
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByText(productName, { exact: true }).first().waitFor()
    steps.push({ step: 'Frontend reload reads real D1 product through authenticated Worker', status: 'passed' })
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await page.screenshot({ path: path.join(evidence, 'worker-smoke-desktop.png') })
    }
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Dashboard must fit the mobile viewport')
    if (evidence) await page.screenshot({ path: path.join(evidence, 'worker-smoke-mobile.png') })
    assert.deepEqual(errors, [], 'Authenticated frontend must not throw JavaScript errors')
    await expectStatus(await post('/api/auth/logout', {}), 200, 'Logout')
    await expectStatus(await get('/api/auth/me'), 401, 'Revoked session rejected')
    if (evidence) await writeFile(path.join(evidence, 'worker-smoke.json'), JSON.stringify({ passed: true, steps, records: { organizationId: organization.id, productId: product.id, invoiceId: invoice.id }, chainTransactions: 0 }, null, 2))
    console.log(JSON.stringify({ passed: true, steps: steps.length, chainTransactions: 0 }))
  } finally {
    await context.close()
    await browser.close()
  }
})
