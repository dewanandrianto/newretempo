import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))

test('default contract test command uses isolated local replay persistence', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['contracts:test'], 'bash scripts/check-contracts-local.sh')
})

test('local runner gives each invocation fresh replay persistence and propagates failures', async () => {
  const dir = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'retempo-runner-test-'))
  try {
    const fixture = path.join(dir, 'forge-fixture.mjs')
    await writeFile(fixture, `#!/usr/bin/env node
console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),replay:process.env.FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR,shrink:process.env.FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT}));
process.exit(Number(process.env.RETEMPO_FIXTURE_EXIT || 0));
`, { mode: 0o755 })
    const env = { ...process.env, FORGE_BIN: fixture, RETEMPO_CHECK_DIR: path.join(dir, 'output') }
    const invoke = (exitCode) => spawnSync('bash', [path.join(root, 'scripts/check-contracts-local.sh'), '--offline', '--match-test', 'test_Example'], {
      cwd: dir, env: { ...env, RETEMPO_FIXTURE_EXIT: String(exitCode) }, encoding: 'utf8',
    })
    const first = invoke(0)
    const second = invoke(37)
    assert.equal(first.status, 0, first.stderr)
    assert.equal(second.status, 37, second.stderr)
    const extract = (result) => JSON.parse(result.stdout.split('\n').find((line) => line.startsWith('{')))
    const a = extract(first)
    const b = extract(second)
    assert.notEqual(a.replay, b.replay, 'Old shortened counterexamples must not leak into a new run')
    assert.ok(a.replay.startsWith(env.RETEMPO_CHECK_DIR + path.sep))
    assert.equal(a.cwd, root.replace(/\/$/, ''))
    assert.equal(a.shrink, '0', 'Only failure shrinking is disabled; run/depth settings remain untouched')
    assert.ok(a.args.includes('--match-test'))
    assert.ok(!a.args.some((arg) => /invariant.*(runs|depth)|fuzz-runs/.test(arg)), 'Runner must not lower test counts')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
