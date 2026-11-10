import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureAssets } from './frontend-assets.mjs'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

test('packaged SPA HTML has anti-framing headers through the real Static Assets runtime', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{ name: 'packaged-spa', modules: true, script: "export default { fetch() { return new Response('Unexpected Worker invocation', { status: 500 }) } }", compatibilityDate: '2026-11-08', assets: { directory: resolve('dist'), binding: 'ASSETS', run_worker_first: ['/api/*'], assetConfig: { not_found_handling: 'single-page-application' } } }],
  }))
  try {
    for (const path of ['/', '/login', '/checkout/review-capability', '/dashboard']) {
      const response = await mf.dispatchFetch(`https://app.retempo.xyz${path}`, { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' } })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /text\/html/)
      assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'")
      assert.equal(response.headers.get('x-frame-options'), 'DENY')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      assert.doesNotMatch(response.headers.get('content-security-policy'), /default-src/)
      assert.equal(await response.text(), await readFile('dist/index.html', 'utf8'))
    }
    assert.equal(await readFile('dist/_headers', 'utf8'), await readFile('public/_headers', 'utf8'))
  } finally {
    await mf.dispose()
  }
})

const graph = await measureAssets('dist')
test('initial HTML/static import graph stays below 250 KiB gzip without preloading wallet routes', () => {
  assert.ok(graph.initialGzipBytes < 250 * 1024, `Initial gzip JS: ${graph.initialGzipBytes}`)
  const initial = new Set(graph.files.map(file => file.file))
  for (const source of ['src/app/providers/WalletRoutes.tsx', 'src/features/customer/CheckoutPage.tsx', 'src/features/dashboard/pages/OverviewPage.tsx']) {
    const asset = graph.manifest[source]
    assert.ok(asset?.isDynamicEntry, `${source} must remain a dynamic entry`)
    assert.equal(initial.has(asset.file), false, `${source} must not be statically preloaded`)
  }
})
