import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { installLocalWallet } from './browser-wallet.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require('/home/deseti/.local/share/retempo/browser-test-tools/node_modules/playwright')

export async function merchantPublishAndCheckout({ base, arc, merchantCookies, planId, subscriptionId, evidence }) {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  let page
  try {
    await context.addCookies([...merchantCookies].map(([name, value]) => ({ name, value, url: base, httpOnly: true, sameSite: 'Lax' })))
    const wallet = await installLocalWallet(context, arc, arc.roles.merchant)
    page = await context.newPage()
    await page.goto(base + '/app/plans', { waitUntil: 'domcontentloaded' })
    await page.getByRole('row').filter({ hasText: 'Verified Escrow Plan' }).getByRole('button', { name: 'Publish onchain', exact: true }).click({ timeout: 20_000 })
    const form = page.getByTestId(`publish-plan-${planId}`)
    await form.getByLabel('Payout address', { exact: true }).fill(arc.roles.merchant.address)
    await form.getByLabel('Arbitrator address', { exact: true }).fill(arc.roles.arbitrator.address)
    await form.getByLabel('Allow customer unvested refunds').check()
    const verify = form.getByRole('button', { name: 'Verify merchant wallet', exact: true })
    if (await verify.isVisible()) await verify.click()
    await form.getByRole('button', { name: 'Prepare plan publication', exact: true }).click({ timeout: 20_000 })
    await form.getByLabel('I reviewed these exact immutable plan terms.').check()
    await form.getByRole('button', { name: 'Publish plan onchain', exact: true }).click()
    await form.getByText(/Verified by the backend|This plan is published in the verified backend/).first().waitFor({ timeout: 20_000 })
    assert.equal(wallet.writes.length, 1)
    await page.screenshot({ path: path.join(evidence, 'signed-plan-publication.png') })
    await page.goto(base + '/app/subscriptions', { waitUntil: 'domcontentloaded' })
    await page.getByRole('row').filter({ hasText: subscriptionId }).getByRole('button', { name: 'Checkout link', exact: true }).click({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Create 24-hour checkout link', exact: true }).click()
    const field = page.getByLabel('Private checkout URL', { exact: true })
    await field.waitFor()
    const url = await field.inputValue()
    assert.equal(new URL(url).origin, base)
    const token = new URL(url).pathname.split('/').pop()
    assert.match(token, /^[a-f0-9]{64}$/)
    return { token, url, signedWalletRequests: wallet.writes }
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(evidence, 'signed-merchant-failure.png') }); console.error('Merchant browser diagnostic:', (await page.locator('body').innerText()).replace(/[a-f0-9]{64}/g, '[CAPABILITY_OR_HASH]').slice(0, 4000)) }
    throw error
  } finally { await context.close(); await browser.close() }
}

export async function renewalInvoiceInBrowser({ base, arc, merchantCookies, subscriptionId, evidence }) {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  let page
  try {
    await context.addCookies([...merchantCookies].map(([name, value]) => ({ name, value, url: base, httpOnly: true, sameSite: 'Lax' })))
    await installLocalWallet(context, arc, arc.roles.merchant)
    page = await context.newPage()
    await page.goto(base + '/app/invoices', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'New invoice', exact: true }).click()
    await page.getByLabel('Subscription (optional)', { exact: true }).selectOption(subscriptionId)
    const period = await page.getByLabel('Billing period start (UTC)', { exact: true }).inputValue()
    assert.match(period, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    assert.equal(await page.getByLabel('Unit price (USDC)', { exact: true }).inputValue(), '100.00')
    await page.getByLabel('Line item', { exact: true }).fill('Actual next subscription billing period')
    const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/invoices'))
    await page.getByRole('button', { name: 'Create draft', exact: true }).click()
    const result = await created
    assert.equal(result.status(), 201)
    const invoice = await result.json()
    await page.getByRole('row').filter({ hasText: invoice.number }).click()
    await page.getByRole('button', { name: 'Finalize', exact: true }).click()
    await page.getByRole('row').filter({ hasText: invoice.number }).filter({ hasText: 'Open' }).click()
    await page.getByRole('button', { name: 'Checkout link', exact: true }).click()
    await page.getByRole('button', { name: 'Create 24-hour checkout link', exact: true }).click()
    const field = page.getByLabel('Private checkout URL', { exact: true })
    await field.waitFor()
    const url = await field.inputValue()
    assert.equal(new URL(url).origin, base)
    await page.screenshot({ path: path.join(evidence, 'signed-renewal-invoice.png') })
    return { invoiceId: invoice.id, token: new URL(url).pathname.split('/').pop(), periodStart: period }
  } catch (error) {
    if (page) console.error('Renewal browser diagnostic:', (await page.locator('body').innerText()).slice(0, 4000))
    throw error
  } finally { await context.close(); await browser.close() }
}

export async function renewalPaymentInBrowser({ base, arc, token, customerCookies }) {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  let page
  try {
    await context.addCookies([...customerCookies].map(([name, value]) => ({ name, value, url: base, httpOnly: true, sameSite: 'Lax' })))
    const wallet = await installLocalWallet(context, arc, arc.roles.customer)
    page = await context.newPage()
    await page.goto(`${base}/checkout/${token}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Approve exact amount & renew', exact: true }).click({ timeout: 20_000 })
    await page.getByText('Confirmed onchain — backend verification pending', { exact: true }).waitFor({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Retry verification', exact: true }).click()
    await page.getByText('Verified by the backend', { exact: true }).waitFor({ timeout: 20_000 })
    assert.equal(wallet.writes.length, 2)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    return wallet.writes
  } catch (error) {
    if (page) console.error('Renewal payment diagnostic:', (await page.locator('body').innerText()).slice(0, 4000))
    throw error
  } finally { await context.close(); await browser.close() }
}

export async function checkoutInBrowser({ base, arc, token, escrowId, customerCookies, merchantCookies, evidence }) {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
  const contexts = []
  const errors = []
  const open = async cookies => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    contexts.push(context)
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, url: base, httpOnly: true, sameSite: 'Lax' })))
    return context
  }
  try {
    const context = await open(customerCookies)
    const wallet = await installLocalWallet(context, arc, arc.roles.customer)
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${base}/checkout/${token}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: /Verified Local Service/ }).waitFor({ timeout: 20_000 })
    const connect = page.getByRole('button', { name: 'Connect wallet', exact: true }).first()
    if (await connect.isVisible()) {
      await connect.click()
      await page.getByText(/Local Arc Wallet|MetaMask|Injected/, { exact: true }).first().click({ timeout: 15_000 })
    }
    const signIn = page.getByRole('button', { name: 'Sign in with this wallet', exact: true })
    if (await signIn.isVisible()) await signIn.click()
    await page.getByRole('checkbox').check()
    const pay = page.getByRole('button', { name: 'Approve exact amount & subscribe', exact: true })
    wallet.wrongGenesis = true
    await pay.click({ timeout: 20_000 })
    await page.getByText(/Wallet RPC world mismatch/).waitFor()
    assert.equal(wallet.writes.length, 0, 'same-chain-ID wrong RPC world must fail before approval')
    wallet.wrongGenesis = false
    wallet.rejectNext = true
    await pay.click()
    await page.getByText('Wallet request rejected', { exact: true }).waitFor()
    assert.equal(wallet.writes.length, 0, 'rejection must not submit a transaction')
    await pay.click()
    await page.getByText('Confirmed onchain — backend verification pending', { exact: true }).waitFor({ timeout: 30_000 })
    assert.equal(wallet.writes.length, 2, 'exact approval plus a single subscription debit')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('Confirmed onchain — backend verification pending', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: /Approve exact amount & (renew|subscribe)/ }).isDisabled(), true)
    await page.getByRole('button', { name: 'Retry verification', exact: true }).click()
    await page.getByText('Verified by the backend', { exact: true }).waitFor({ timeout: 20_000 })
    assert.equal(wallet.writes.length, 2, 'reload and verification retry must never resubmit payment')
    await page.screenshot({ path: path.join(evidence, 'signed-checkout-desktop.png') })
    for (const width of [320, 360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `checkout overflow at ${width}px`)
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(evidence, 'signed-checkout-mobile.png') })
    await page.goto(base + '/portal', { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Your subscriptions', exact: true }).waitFor()
    await page.getByText(wallet.writes[1].hash, { exact: true }).first().waitFor()
    for (const width of [320, 360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `portal overflow at ${width}px`)
    }
    await page.screenshot({ path: path.join(evidence, 'signed-customer-portal.png') })
    const merchantContext = await open(merchantCookies)
    await installLocalWallet(merchantContext, arc, arc.roles.merchant)
    const dashboard = await merchantContext.newPage()
    dashboard.on('pageerror', error => errors.push(error.message))
    await dashboard.goto(base + '/app/payments', { waitUntil: 'domcontentloaded' })
    await dashboard.getByRole('row').filter({ hasText: '100.00' }).filter({ hasText: /succeeded/i }).first().waitFor({ timeout: 20_000 })
    await dashboard.goto(base + '/app', { waitUntil: 'domcontentloaded' })
    await dashboard.getByRole('heading', { name: 'Overview', exact: true }).waitFor()
    await dashboard.getByText(/100\.00\s+USDC/).first().waitFor()
    const body = await dashboard.locator('body').innerText()
    assert.equal(/Sample figure|demo data/i.test(body), false, 'live dashboard must not display demo financial data')
    await dashboard.screenshot({ path: path.join(evidence, 'signed-dashboard-desktop.png') })
    for (const width of [320, 360, 390, 768, 1440]) {
      await dashboard.setViewportSize({ width, height: 900 })
      assert.equal(await dashboard.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `dashboard overflow at ${width}px`)
    }
    await dashboard.setViewportSize({ width: 390, height: 844 })
    await dashboard.screenshot({ path: path.join(evidence, 'signed-dashboard-mobile.png') })
    await dashboard.goto(base + '/app/escrow', { waitUntil: 'domcontentloaded' })
    await dashboard.getByTestId(`merchant-escrow-${escrowId}`).waitFor()
    for (const width of [320, 360, 390, 768, 1440]) {
      await dashboard.setViewportSize({ width, height: 900 })
      assert.equal(await dashboard.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `merchant escrow overflow at ${width}px`)
    }
    await dashboard.screenshot({ path: path.join(evidence, 'signed-merchant-escrow.png') })
    assert.deepEqual(errors, [], 'real checkout/dashboard must not throw browser JavaScript exceptions')
    return { signedWalletRequests: wallet.writes, wrongWorldBlockedBeforeApproval: true, rejectionBeforeSubmission: true, reloadRetryDidNotDoublePay: true, responsiveWidths: [320, 360, 390, 768, 1440], pageErrors: errors }
  } catch (error) {
    const page = contexts[contexts.length - 1]?.pages()[0]
    if (page) {
      await page.screenshot({ path: path.join(evidence, 'signed-browser-failure.png'), fullPage: true }).catch(() => {})
      console.error('Browser diagnostic:', (await page.locator('body').innerText()).slice(0, 4000))
      console.error('Overflow elements:', await page.evaluate(() => [...document.querySelectorAll('body *')].filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.right > innerWidth + 1 }).slice(-20).map(element => ({ tag: element.tagName, class: element.className.baseVal ?? element.className, text: element.textContent.slice(0, 70), right: Math.round(element.getBoundingClientRect().right) }))))
    }
    throw error
  } finally {
    for (const context of contexts) await context.close()
    await browser.close()
  }
}
