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
  test(`landing fits a ${width}px viewport and keeps code scrolling inside its panel`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'Subscription billing that settles in USDC.' }).waitFor()
      const developers = page.locator('#developers')
      await developers.scrollIntoViewIfNeeded()
      const dimensions = await page.evaluate(() => {
        const section = document.querySelector('#developers')
        const pre = section.querySelector('pre')
        const panel = pre.parentElement
        return {
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          sectionRight: section.getBoundingClientRect().right,
          panelRight: panel.getBoundingClientRect().right,
          panelWidth: panel.clientWidth,
          preWidth: pre.clientWidth,
          preScrollWidth: pre.scrollWidth,
          preOverflow: getComputedStyle(pre).overflowX,
          codeText: pre.textContent,
        }
      })
      if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, `landing-${width}.png`) })
      assert.ok(dimensions.document <= dimensions.viewport, `Page overflow: ${JSON.stringify(dimensions)}`)
      assert.ok(dimensions.panelRight <= dimensions.viewport, `Code panel exceeds viewport: ${JSON.stringify(dimensions)}`)
      assert.ok(dimensions.preWidth <= dimensions.panelWidth, 'Code viewport must fit its panel')
      assert.match(dimensions.preOverflow, /auto|scroll/, 'Long code must remain horizontally scrollable, not clipped')
      assert.match(dimensions.codeText, /customerEmail: 'billing@example.com'/, 'Code content must not be removed to hide overflow')
      assert.deepEqual(errors, [], 'Landing must not raise uncaught JavaScript errors')
    } finally {
      await page.close()
    }
  })
}
