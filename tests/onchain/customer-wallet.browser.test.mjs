import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { verifyMessage } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.RETEMPO_PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.RETEMPO_PREVIEW_URL || 'http://127.0.0.1:4319'
const evidence = process.env.RETEMPO_BROWSER_EVIDENCE_DIR || path.join(tmpdir(), 'retempo-customer-wallet-browser')
const account = privateKeyToAccount(generatePrivateKey())
const token = 'ab'.repeat(32)
const hash = `0x${'11'.repeat(32)}`
const configuration = { chainId: 5042002, mode: 'disabled', configured: false, rpcUrl: 'https://rpc.blockdaemon.testnet.arc.io', explorerUrl: 'https://testnet.arcscan.app', usdc: '0x3600000000000000000000000000000000000000', usdcDecimals: 6, manager: null, escrow: null, startBlock: null, reason: 'Local browser QA disables all payments.' }
const checkout = { id: 'local-browser-checkout', status: 'open', expiresAt: '2099-01-01T00:00:00Z', merchantName: 'Local HTTP fixture', productName: 'Customer wallet verification', planName: 'Local browser QA', description: 'Isolated HTTP fixture. Not a live product, customer, or payment.', amount: '1000000', interval: 'month', intervalSeconds: 2592000, trialDays: 0, escrowDays: 0, planKey: hash, merchant: '0x1111111111111111111111111111111111111111', payout: '0x2222222222222222222222222222222222222222', arbitrator: '0x0000000000000000000000000000000000000000', customerMayRefundUnvested: false, subscriptionId: 'local-subscription', invoiceId: 'local-invoice', configuration }
const results = []
let browser

before(async () => {
  await mkdir(evidence, { recursive: true })
  browser = await chromium.launch({ executablePath: process.env.RETEMPO_CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
})
after(async () => {
  await browser?.close()
  await writeFile(path.join(evidence, 'customer-wallet-results.json'), JSON.stringify(results, null, 2))
})

async function fixture(width, mode = 'available') {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
  const errors = []
  const signed = []
  let linked = false
  let verifyCount = 0
  let prepareCount = 0
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeFunction('__localSignMessage', async raw => {
    signed.push(raw)
    return account.signMessage({ message: { raw } })
  })
  await page.addInitScript(({ address, chain }) => {
    const listeners = new Map()
    window.__walletMethods = []
    window.__rejectSignature = false
    window.ethereum = {
      isMetaMask: true,
      isConnected: () => true,
      on: (event, listener) => { listeners.set(event, [...(listeners.get(event) || []), listener]) },
      removeListener: (event, listener) => { listeners.set(event, (listeners.get(event) || []).filter(item => item !== listener)) },
      request: async ({ method, params }) => {
        window.__walletMethods.push(method)
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address]
        if (method === 'eth_chainId') return chain
        if (method === 'net_version') return String(parseInt(chain, 16))
        if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return [{ parentCapability: 'eth_accounts' }]
        if (method === 'personal_sign') {
          if (window.__rejectSignature) { const error = new Error('User rejected the request.'); error.code = 4001; throw error }
          return window.__localSignMessage(params[0])
        }
        if (method === 'wallet_switchEthereumChain') return null
        throw new Error(`Local QA forbids provider method ${method}`)
      },
    }
  }, { address: account.address, chain: `0x${Number(5042002).toString(16)}` })
  const message = createSiweMessage({ address: account.address, chainId: 5042002, domain: new URL(base).host, uri: base, version: '1', nonce: 'localqa1234567890', statement: 'Link this wallet to this isolated local checkout. This does not approve a payment.' })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    const respond = (json, status = 200) => route.fulfill({ status, json })
    if (pathname === '/api/auth/config') return respond({ enabled: false, appId: null })
    if (pathname === '/api/auth/me') return respond({ user: { id: 'local-customer-user', email: null, emailVerified: true, displayName: 'Local browser QA', wallets: linked ? [{ address: account.address, chainId: 5042002 }] : [] }, memberships: [], policy: { requireVerifiedEmail: true } })
    if (pathname === '/api/chain/config') return respond(configuration)
    if (pathname.endsWith('/customer-wallet/nonce')) {
      assert.equal(request.postDataJSON().address.toLowerCase(), account.address.toLowerCase())
      return respond({ message, expiresAt: new Date(Date.now() + 300000).toISOString() }, 201)
    }
    if (pathname.endsWith('/customer-wallet/verify')) {
      const proof = request.postDataJSON()
      assert.equal(proof.message, message)
      assert.equal(await verifyMessage({ address: account.address, message, signature: proof.signature }), true)
      linked = true
      verifyCount += 1
      return respond({ linked: true, address: account.address })
    }
    if (pathname.endsWith('/customer-wallet')) {
      if (mode === 'status-error') return respond({ error: { code: 'unavailable', message: 'Local QA status failure' } }, 503)
      return respond({ linked, available: mode !== 'merchant', reason: mode === 'merchant' ? 'merchant_wallet' : null })
    }
    if (pathname.endsWith('/prepare')) {
      prepareCount += 1
      return respond({ error: { code: 'forbidden', message: 'Local QA forbids payment preparation' } }, 403)
    }
    if (pathname === `/api/public/checkouts/${token}`) return respond(checkout)
    return respond({ error: { code: 'not_found', message: 'Not part of local QA fixture' } }, 404)
  })
  await page.goto(`${base}/checkout/${token}`, { waitUntil: 'networkidle' })
  try {
    await page.getByRole('heading', { name: /Customer wallet verification/ }).waitFor()
    await page.getByRole('main').getByRole('button', { name: 'Connect test wallet' }).click()
  } catch (error) {
    console.error('Local fixture setup failed:', page.url(), await page.locator('body').innerText(), errors)
    await page.close()
    throw error
  }
  return { page, errors, signed, verified: () => verifyCount, prepared: () => prepareCount }
}

async function assertNoPayment(f) {
  const methods = await f.page.evaluate(() => window.__walletMethods)
  assert.deepEqual(methods.filter(method => /sendTransaction|sendRawTransaction|sendCalls|signTransaction|signTypedData/i.test(method)), [])
  assert.equal(f.prepared(), 0)
  assert.deepEqual(f.errors, [])
  const dimensions = await f.page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
  assert.ok(dimensions.document <= dimensions.viewport, JSON.stringify(dimensions))
  return dimensions
}

for (const width of [320, 360, 390, 768, 1440]) test(`customer ownership linking fits ${width}px and signs only one message`, async () => {
  const f = await fixture(width)
  try {
    const button = f.page.getByRole('button', { name: 'Verify and link this wallet' })
    await button.waitFor()
    assert.equal(await f.page.getByRole('button', { name: 'Approve and subscribe' }).isDisabled(), true)
    await button.click()
    await f.page.getByText('Wallet ownership is verified and linked to this checkout. No payment was made.', { exact: true }).waitFor()
    assert.equal(f.verified(), 1)
    assert.equal(f.signed.length, 1)
    assert.equal(await f.page.getByRole('button', { name: 'Verify and link this wallet' }).count(), 0)
    const dimensions = await assertNoPayment(f)
    await f.page.screenshot({ path: path.join(evidence, `customer-linked-${width}.png`), fullPage: true })
    results.push({ case: 'customer-linked', width, ...dimensions, signatureCount: f.signed.length, transactionCount: 0 })
  } finally { await f.page.close() }
})

test('merchant wallet collision cannot request an ownership proof', async () => {
  const f = await fixture(390, 'merchant')
  try {
    await f.page.getByText('The customer wallet must be different from the merchant and payout wallets.', { exact: true }).waitFor()
    assert.equal(await f.page.getByRole('button', { name: 'Verify and link this wallet' }).count(), 0)
    assert.equal(f.signed.length, 0)
    await assertNoPayment(f)
    results.push({ case: 'merchant-wallet-rejected', passed: true })
  } finally { await f.page.close() }
})

test('signature cancellation leaves the wallet unlinked and sends no transaction', async () => {
  const f = await fixture(390)
  try {
    await f.page.getByRole('button', { name: 'Verify and link this wallet' }).waitFor()
    await f.page.evaluate(() => { window.__rejectSignature = true })
    await f.page.getByRole('button', { name: 'Verify and link this wallet' }).click()
    await f.page.getByText('Signature cancelled. No wallet was linked.', { exact: true }).waitFor()
    assert.equal(f.verified(), 0)
    assert.equal(f.signed.length, 0)
    await assertNoPayment(f)
    results.push({ case: 'signature-cancelled', passed: true })
  } finally { await f.page.close() }
})

test('unverifiable association status fails closed', async () => {
  const f = await fixture(390, 'status-error')
  try {
    await f.page.getByText('The customer wallet status could not be verified. Refresh the page and try again.', { exact: true }).waitFor()
    assert.equal(await f.page.getByRole('button', { name: 'Verify and link this wallet' }).count(), 0)
    assert.equal(await f.page.getByRole('button', { name: 'Approve and subscribe' }).isDisabled(), true)
    await assertNoPayment(f)
    results.push({ case: 'association-status-error', passed: true })
  } finally { await f.page.close() }
})
