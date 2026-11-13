import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { encodeAbiParameters, keccak256, parseAbiParameters, toFunctionSelector, verifyMessage } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.RETEMPO_PLAYWRIGHT_MODULE || '/home/ubuntu/.local/share/retempo/browser-test-tools/node_modules/playwright')
const base = process.env.RETEMPO_PREVIEW_URL || 'http://127.0.0.1:4321'
const evidence = process.env.RETEMPO_BROWSER_EVIDENCE_DIR || path.join(tmpdir(), 'retempo-merchant-wallet-browser')
const account = privateKeyToAccount(generatePrivateKey())
const orgId = 'synthetic-owner-org'
const userId = 'synthetic-privy-owner'
const org = { id: orgId, name: 'Synthetic workspace', slug: 'synthetic-workspace', website: null, industry: 'software', country: 'ID', createdAt: '2026-11-13T00:00:00.000Z' }
const manager = '0x1111111111111111111111111111111111111111'
const escrow = '0x2222222222222222222222222222222222222222'
const usdc = '0x3600000000000000000000000000000000000000'
const code = '0x60006000'
const genesisHash = `0x${'11'.repeat(32)}`
const configuration = {
  chainId: 5042002,
  mode: 'testnet',
  configured: true,
  rpcUrl: 'https://rpc.testnet.arc.io/',
  explorerUrl: 'https://testnet.arcscan.app',
  usdc,
  usdcDecimals: 6,
  manager,
  escrow,
  managerPaused: false,
  escrowPaused: false,
  startBlock: '1',
  genesisHash,
  managerCodeHash: keccak256(code),
  escrowCodeHash: keccak256(code),
}
const plan = { id: 'synthetic-plan-id', productId: 'synthetic-product-id', productName: 'Synthetic service', name: 'Synthetic monthly plan', amount: '10000000', interval: 'month', trialDays: 0, escrowDays: 0, status: 'active', subscriberCount: 0, createdAt: '2026-11-13T00:00:00.000Z' }
const chainIdHex = `0x${BigInt(configuration.chainId).toString(16)}`
const managerFunctions = {
  [toFunctionSelector('usdc()').toLowerCase()]: encodeAbiParameters(parseAbiParameters('address'), [usdc]),
  [toFunctionSelector('escrow()').toLowerCase()]: encodeAbiParameters(parseAbiParameters('address'), [escrow]),
}
const escrowFunctions = {
  [toFunctionSelector('manager()').toLowerCase()]: encodeAbiParameters(parseAbiParameters('address'), [manager]),
}
const tokenFunctions = {
  [toFunctionSelector('decimals()').toLowerCase()]: encodeAbiParameters(parseAbiParameters('uint8'), [6]),
  [toFunctionSelector('balanceOf(address)').toLowerCase()]: encodeAbiParameters(parseAbiParameters('uint256'), [0n]),
}
const results = []
let browser

before(async () => {
  await mkdir(evidence, { recursive: true })
  browser = await chromium.launch({ executablePath: process.env.RETEMPO_CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
})
after(async () => {
  await browser?.close()
  await writeFile(path.join(evidence, 'merchant-wallet-browser-results.json'), JSON.stringify(results, null, 2))
})

function accountResponse(linked) {
  return {
    user: { id: userId, email: null, emailVerified: true, displayName: 'Synthetic Privy owner', wallets: linked ? [{ address: account.address.toLowerCase(), chainId: 5042002 }] : [] },
    memberships: [{ organization: org, role: 'owner', createdAt: '2026-11-13T00:00:00.000Z' }],
    policy: { requireVerifiedEmail: false },
    session: { method: 'privy' },
  }
}

function rpcResult(request) {
  if (request.method === 'eth_chainId') return chainIdHex
  if (request.method === 'net_version') return String(configuration.chainId)
  if (request.method === 'eth_getBlockByNumber') return { number: request.params?.[0] ?? '0x0', hash: genesisHash, parentHash: `0x${'00'.repeat(32)}`, nonce: '0x0000000000000000', sha3Uncles: `0x${'00'.repeat(32)}`, logsBloom: `0x${'00'.repeat(256)}`, transactionsRoot: `0x${'00'.repeat(32)}`, stateRoot: `0x${'00'.repeat(32)}`, receiptsRoot: `0x${'00'.repeat(32)}`, miner: '0x0000000000000000000000000000000000000000', difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x67240000', transactions: [], uncles: [] }
  if (request.method === 'eth_getCode') return code
  if (request.method === 'eth_call') {
    const to = request.params?.[0]?.to?.toLowerCase()
    const selector = request.params?.[0]?.data?.slice(0, 10).toLowerCase()
    if (to === manager.toLowerCase() && managerFunctions[selector]) return managerFunctions[selector]
    if (to === escrow.toLowerCase() && escrowFunctions[selector]) return escrowFunctions[selector]
    if (to === usdc.toLowerCase() && tokenFunctions[selector]) return tokenFunctions[selector]
    return '0x'
  }
  return null
}

async function fixture() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  const errors = []
  const consoleErrors = []
  const apiRequests = []
  const counters = { merchantChallenge: 0, merchantVerify: 0, loginVerify: 0, transactions: 0, signedMessages: 0 }
  let linked = false
  let currentMessage
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('response', response => { if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`) })
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) apiRequests.push(`${request.method()} ${url.pathname}`) })
  await page.exposeFunction('__signMerchantMessage', async raw => {
    counters.signedMessages += 1
    return account.signMessage({ message: { raw } })
  })
  await page.addInitScript(({ address, chainId: id, genesisHash: genesis, code: deployedCode }) => {
    const listeners = new Map()
    window.__walletMethods = []
    const provider = {
      isMetaMask: true,
      isConnected: () => true,
      selectedAddress: address,
      chainId: id,
      on: (event, listener) => { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); return provider },
      removeListener: (event, listener) => { listeners.get(event)?.delete(listener); return provider },
      request: async ({ method, params = [] }) => {
        window.__walletMethods.push(method)
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address]
        if (method === 'eth_chainId') return id
        if (method === 'net_version') return String(parseInt(id, 16))
        if (method === 'eth_getBlockByNumber') return { number: params[0] ?? '0x0', hash: genesis, parentHash: `0x${'00'.repeat(32)}`, timestamp: '0x67240000' }
        if (method === 'eth_getCode') return deployedCode
        if (method === 'eth_call') return '0x'
        if (method === 'wallet_getPermissions' || method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }]
        if (method === 'wallet_getCapabilities') return {}
        if (method === 'wallet_switchEthereumChain') return null
        if (method === 'personal_sign') return window.__signMerchantMessage(params[0])
        if (/sendTransaction|sendRawTransaction|sendCalls|signTransaction|signTypedData/i.test(method)) throw new Error(`Local QA forbids transaction/signing method ${method}`)
        throw new Error(`Local QA forbids wallet method ${method}`)
      },
    }
    Object.defineProperty(window, 'ethereum', { value: provider, configurable: true })
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: '9f803cc4-d720-4aac-9a7a-c50826da2ff5', name: 'Synthetic QA Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'test.retempo.synthetic' }, provider } }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
  }, { address: account.address, chainId: chainIdHex, genesisHash, code })

  await page.route('https://rpc.testnet.arc.io/**', async route => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' } })
    const payload = req.postDataJSON()
    const answer = item => ({ jsonrpc: '2.0', id: item.id, result: rpcResult(item) })
    const body = Array.isArray(payload) ? payload.map(answer) : answer(payload)
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) })
  })

  await page.route(`${base}/api/**`, async route => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    const respond = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) })
    if (pathname === '/api/auth/config') return respond({ enabled: false, appId: null })
    if (pathname === '/api/auth/me') return respond(accountResponse(linked))
    if (pathname === `/api/orgs/${orgId}/plans`) return respond([plan])
    if (pathname === `/api/orgs/${orgId}/merchant-wallet/status`) return respond({ verified: linked, available: true, reason: null })
    if (pathname === '/api/chain/config') return respond(configuration)
    if (pathname === `/api/orgs/${orgId}/chain/snapshot`) return respond({ configuration, cursor: null, bindings: [], events: [], projections: [] })
    if (pathname === `/api/orgs/${orgId}/merchant-wallet/nonce`) {
      counters.merchantChallenge += 1
      const body = request.postDataJSON()
      assert.equal(body.address.toLowerCase(), account.address.toLowerCase())
      currentMessage = createSiweMessage({ address: account.address, chainId: configuration.chainId, domain: new URL(base).host, uri: base, version: '1', nonce: `qa${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`, statement: 'Verify and link this merchant wallet to your current RETEMPO account and organization. This does not create or switch accounts, send a transaction, or cost gas.', issuedAt: new Date(), expirationTime: new Date(Date.now() + 300_000) })
      return respond({ message: currentMessage, expiresAt: new Date(Date.now() + 300_000).toISOString() }, 201)
    }
    if (pathname === `/api/orgs/${orgId}/merchant-wallet/verify`) {
      counters.merchantVerify += 1
      const proof = request.postDataJSON()
      assert.equal(proof.message, currentMessage)
      assert.equal(await verifyMessage({ address: account.address, message: proof.message, signature: proof.signature }), true)
      linked = true
      return respond(accountResponse(true))
    }
    if (pathname === '/api/auth/siwe/verify') {
      counters.loginVerify += 1
      return respond({ error: { code: 'unexpected_login', message: 'Local QA: merchant verification must never call wallet sign-in.' } }, 500)
    }
    if (pathname === '/api/auth/siwe/link/verify') return respond({ error: { code: 'unexpected_account_link', message: 'Local QA: merchant verification must use its org-specific route.' } }, 500)
    if (/\/prepare$/.test(pathname)) return respond({ error: { code: 'forbidden', message: 'Local QA forbids preparation and transactions.' } }, 403)
    return respond({ error: { code: 'not_found', message: `Not part of local QA fixture: ${pathname}` } }, 404)
  })

  await page.goto(`${base}/app/plans`, { waitUntil: 'domcontentloaded' })
  try {
    await page.getByRole('heading', { name: 'Subscription Plans', exact: true }).waitFor({ timeout: 20_000 })
  } catch (error) {
    const body = (await page.locator('body').innerText()).slice(0, 3000)
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nQA URL: ${page.url()}\nBODY: ${body}\nPAGE ERRORS: ${errors.join(' | ')}\nCONSOLE ERRORS: ${consoleErrors.join(' | ')}`)
  }
  await page.getByText(plan.name, { exact: true }).waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Publish onchain', exact: true }).click()
  const modal = page.getByTestId(`publish-plan-${plan.id}`)
  await modal.waitFor({ timeout: 10_000 })
  const connectWallet = modal.getByRole('button', { name: 'Connect test wallet', exact: true })
  if (await connectWallet.count()) await connectWallet.click({ timeout: 10_000 })
  else await modal.getByLabel(/^Active wallet /).waitFor({ timeout: 10_000 })
  await modal.getByRole('button', { name: 'Verify merchant wallet', exact: true }).waitFor({ timeout: 10_000 })
  return { page, modal, errors, counters, apiRequests, walletMethods: () => page.evaluate(() => window.__walletMethods), orgLabel: org.name }
}

test('merchant wallet verification preserves the logged-in Privy owner/workspace and makes no transaction on mobile', async () => {
  const f = await fixture()
  try {
    assert.match(await f.modal.innerText(), /will not sign in to another account or approve a transaction/i)
    const watchRequest = (suffix) => new Promise(resolve => {
      const listener = request => {
        if (!new URL(request.url()).pathname.endsWith(suffix)) return
        f.page.off('request', listener)
        resolve(request)
      }
      f.page.on('request', listener)
    })
    const flowRequests = Promise.all([watchRequest('/merchant-wallet/nonce'), watchRequest('/merchant-wallet/verify')])
    await f.modal.getByRole('button', { name: 'Verify merchant wallet', exact: true }).click()
    try {
      await Promise.race([flowRequests, f.page.waitForTimeout(15_000).then(() => { throw new Error('No merchant challenge/verify request was observed within 15 seconds') })])
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nMODAL: ${(await f.modal.innerText()).slice(0, 2000)}\nALERTS: ${JSON.stringify(await f.modal.getByRole('alert').allInnerTexts())}\nWALLET METHODS: ${JSON.stringify(await f.walletMethods())}\nAPI: ${f.apiRequests.join(', ')}`)
    }
    await f.modal.getByRole('button', { name: 'Verify merchant wallet', exact: true }).waitFor({ state: 'detached', timeout: 10_000 })
    await f.page.getByRole('heading', { name: 'Subscription Plans', exact: true }).waitFor()
    await f.page.getByText(f.orgLabel, { exact: true }).first().waitFor({ timeout: 10_000 })
    await f.page.getByText(plan.name, { exact: true }).waitFor()
    if (f.counters.merchantChallenge !== 1) throw new Error(`Wallet proof did not start. MODAL: ${(await f.modal.innerText()).slice(0, 2000)}. API: ${f.apiRequests.join(', ')}`)
    await f.modal.getByRole('button', { name: 'Prepare plan publication', exact: true }).waitFor({ timeout: 10_000 })
    assert.equal(f.counters.merchantChallenge, 1)
    assert.equal(f.counters.merchantVerify, 1)
    assert.equal(f.counters.loginVerify, 0, 'merchant verify must not call SIWE login')
    assert.equal(f.counters.signedMessages, 1, 'ownership must use one signature')
    const methods = await f.walletMethods()
    assert.deepEqual(methods.filter(method => /sendTransaction|sendRawTransaction|sendCalls|signTransaction|signTypedData/i.test(method)), [])
    assert.equal(f.errors.length, 0, f.errors.join('\n'))
    const widths = []
    for (const width of [320, 360, 390, 768, 1440]) {
      await f.page.setViewportSize({ width, height: 900 })
      const dimensions = await f.page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
      assert.ok(dimensions.document <= dimensions.viewport, `overflow at ${width}px: ${JSON.stringify(dimensions)}`)
      widths.push(width)
    }
    results.push({ test: 'merchant-wallet-session-preserved', orgId, userId, signedMessages: f.counters.signedMessages, loginVerifyCalls: f.counters.loginVerify, transactionMethods: methods.filter(method => /sendTransaction|sendRawTransaction|sendCalls|signTransaction|signTypedData/i.test(method)), responsiveWidths: widths, sessionPreserved: true })
  } finally {
    await f.page.close()
  }
})
