import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { before, after, test } from 'node:test'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.RETEMPO_PLAYWRIGHT_MODULE || '/home/deseti/.local/share/retempo/browser-test-tools/node_modules/playwright')
const base = 'http://127.0.0.1:4327'
const manifest = JSON.parse(await readFile('dist/.vite/manifest.json', 'utf8'))
const invoice = manifest['src/features/customer/InvoicePage.tsx'].file
const wallet = manifest['src/app/providers/WalletRoutes.tsx'].file
let server, browser
before(async () => {
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4327', '--strictPort'], { stdio: 'ignore' })
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(base)).ok) break } catch { /* Wait for the owned preview. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
})
after(async () => { await browser?.close(); server?.kill() })
async function pageFixture() {
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } })
  page.setDefaultTimeout(5000)
  await page.route('**/api/**', route => route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Capability expired or revoked' } } }))
  return page
}
test('delayed route chunks show a visible loading state and then render the real route', async () => {
  const page = await pageFixture()
  let release
  const gate = new Promise(resolve => { release = resolve })
  await page.route(`**/${invoice}`, async route => { await gate; await route.continue() })
  try {
    await page.goto(`${base}/invoice/invalid-capability`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('status').filter({ hasText: 'Loading page' }).waitFor()
    release()
    await page.getByRole('heading', { name: 'Payment link unavailable' }).waitFor()
    assert.equal(await page.getByText('Loading page…', { exact: true }).count(), 0)
  } finally { release(); await page.close() }
})
test('failed route chunks show a recoverable error instead of a blank page', async () => {
  const page = await pageFixture()
  await page.route(`**/${invoice}`, route => route.abort('failed'))
  try {
    await page.goto(`${base}/invoice/invalid-capability`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Unable to load page' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Reload page' }).isVisible(), true)
    await page.getByRole('link', { name: 'Return home' }).click()
    await page.waitForURL(base + '/')
    assert.ok(await page.locator('main').innerText())
  } finally { await page.close() }
})
test('landing does not fetch wallet routes; client navigation loads real wallet provider', async () => {
  const page = await pageFixture()
  const requests = []
  page.on('request', request => requests.push(new URL(request.url()).pathname))
  try {
    await page.goto(base, { waitUntil: 'networkidle' })
    assert.equal(requests.includes('/' + wallet), false)
    await page.getByRole('link', { name: 'Log in', exact: true }).last().click()
    await page.waitForURL(base + '/login')
    await page.getByRole('button', { name: 'Continue with wallet' }).waitFor()
    assert.equal(requests.includes('/' + wallet), true)
    await page.getByRole('button', { name: 'Continue with wallet' }).click()
    await page.getByRole('dialog').waitFor()
  } finally { await page.close() }
})
