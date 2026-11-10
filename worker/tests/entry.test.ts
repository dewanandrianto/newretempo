import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import worker from '../src/index'
import type { WorkerBindings } from '../src/types'

const bindings = env as unknown as WorkerBindings

test('the real Worker reaches local D1 through Drizzle', async () => {
  const response = await worker.fetch(new Request('https://app.test/api/health'), bindings)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, runtime: 'cloudflare-workers', database: 'd1' })
})

test('merchant routes remain protected at the actual Worker entrypoint', async () => {
  const response = await worker.fetch(new Request('https://app.test/api/orgs'), bindings)
  expect(response.status).toBe(401)
})

test('an unknown API path never falls back to an HTML asset', async () => {
  const response = await worker.fetch(new Request('https://app.test/api/missing'), bindings)
  expect(response.status).toBe(404)
  expect(response.headers.get('content-type')).toContain('application/json')
})
