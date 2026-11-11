import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { after, before, test } from 'node:test'

// Keep browser tooling separate from application runtime dependencies.
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.RETEMPO_PLAYWRIGHT_MODULE || 'playwright')
const baseUrl = process.env.RETEMPO_PREVIEW_URL || 'http://127.0.0.1:4179'
const evidenceDir = process.env.RETEMPO_BROWSER_EVIDENCE_DIR
let browser

before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.RETEMPO_CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  })
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true })
})
after(async () => { await browser?.close() })

for (const width of [320, 360, 390, 768, 1440]) {
  test(`landing fits a ${width}px viewport without horizontal overflow or placeholder data`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'Subscription billing, made clearer.' }).waitFor()
      await page.locator('#features').waitFor()
      await page.locator('#developers').scrollIntoViewIfNeeded()
      const dimensions = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        sections: [...document.querySelectorAll('main section')].map((section) => ({
          id: section.id,
          left: section.getBoundingClientRect().left,
          right: section.getBoundingClientRect().right,
        })),
        hasPlaceholderCode: Boolean(document.querySelector('#developers pre')),
        pageText: document.querySelector('main')?.innerText ?? '',
      }))
      if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, `landing-${width}.png`) })
      assert.ok(dimensions.document <= dimensions.viewport, `Page overflow: ${JSON.stringify(dimensions)}`)
      assert.ok(dimensions.sections.every((section) => section.left >= 0 && section.right <= dimensions.viewport), `A section exceeds the viewport: ${JSON.stringify(dimensions.sections)}`)
      assert.equal(dimensions.hasPlaceholderCode, false, 'Landing must not display placeholder SDK or business code')
      assert.doesNotMatch(dimensions.pageText, /billing@example\.com|Local Arc Wallet/i, 'Landing must not display fictitious business or provider labels')
      assert.deepEqual(errors, [], 'Landing must not raise uncaught JavaScript errors')
    } finally {
      await page.close()
    }
  })
}
