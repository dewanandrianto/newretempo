import { readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

// Measure emitted bytes, not source estimates. Dynamic imports are intentionally excluded.
export async function measureAssets(directory) {
  const html = await readFile(path.join(directory, 'index.html'), 'utf8')
  const manifest = JSON.parse(await readFile(path.join(directory, '.vite/manifest.json'), 'utf8'))
  const roots = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+\.js)"[^>]*>/g)].map(match => match[1].replace(/^\//, ''))
  const byFile = new Map(Object.entries(manifest).map(([key, value]) => [value.file, key]))
  const visited = new Set()
  const edges = []
  function visit(file) {
    if (visited.has(file)) return
    visited.add(file)
    const item = manifest[byFile.get(file)]
    for (const key of item?.imports ?? []) {
      const dependency = manifest[key].file
      edges.push({ from: file, to: dependency })
      visit(dependency)
    }
  }
  roots.forEach(visit)
  if (roots.length === 0) throw new Error('No initial JavaScript found in emitted index.html')
  const files = await Promise.all([...visited].sort().map(async file => {
    const bytes = await readFile(path.join(directory, file))
    return { file, bytes: bytes.length, gzipBytes: gzipSync(bytes).length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }))
  const allJs = Object.values(manifest).filter(item => item.file.endsWith('.js'))
  const emittedSizes = await Promise.all(allJs.map(item => stat(path.join(directory, item.file))))
  return {
    method: 'index.html scripts/modulepreloads plus recursive manifest static imports; gzip per asset, default zlib level; excludes deferred route requests, CSS, HTTP headers and cache effects',
    roots, edges, files,
    initialJsCount: files.length,
    initialBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    initialGzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
    emittedJsCount: allJs.length,
    emittedJsBytes: emittedSizes.reduce((sum, file) => sum + file.size, 0),
    manifest,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = JSON.stringify(await measureAssets(process.argv[2] ?? 'dist'), null, 2) + '\n'
  if (process.argv[3]) await writeFile(process.argv[3], result)
  else process.stdout.write(result)
}
