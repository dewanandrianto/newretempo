import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { createWorkerApp } from '../src/index'
import { hmac, randomToken } from '../src/auth/crypto'
import { disabledConfiguration } from '../src/chain/client'
import type { WorkerBindings } from '../src/types'

const bindings = env as unknown as WorkerBindings

test('refuses excess customer tenant fanout before service requests rather than truncating financial history', async () => {
  const user = crypto.randomUUID(), token = randomToken()
  const address = '0x' + randomToken(20)
  await bindings.DB.prepare('INSERT INTO users(id,display_name) VALUES (?,?)').bind(user, 'Fanout fixture').run()
  await bindings.DB.prepare("INSERT INTO sessions(id,user_id,token_hash,auth_method,idle_expires_at,expires_at) VALUES (?,?,?,'siwe','2099-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')").bind(crypto.randomUUID(), user, await hmac(bindings.SESSION_SECRET, token)).run()
  await bindings.DB.prepare("INSERT INTO wallets(id,purpose,user_id,address,chain_id,verified_at,verification_method) VALUES (?,'login',?,?,5042002,?,'siwe')").bind(crypto.randomUUID(), user, address, new Date().toISOString()).run()
  // Actual D1 relationships, not a SQL emulator. The service below is an explicit empty-state fixture.
  const orgs: string[] = []
  for (let i = 0; i < 21; i++) {
    const org = crypto.randomUUID(), customer = crypto.randomUUID()
    orgs.push(org)
    await bindings.DB.batch([
      bindings.DB.prepare('INSERT INTO organizations(id,name,slug,industry,country,created_by) VALUES (?,?,?,?,?,?)').bind(org, 'Fanout fixture', org, 'Software', 'US', user),
      bindings.DB.prepare('INSERT INTO customers(id,org_id,name,email) VALUES (?,?,?,?)').bind(customer, org, 'Customer', 'fanout@example.test'),
      bindings.DB.prepare("INSERT INTO wallets(id,purpose,org_id,customer_id,address,chain_id) VALUES (?,'customer',?,?,?,5042002)").bind(crypto.randomUUID(), org, customer, address),
    ])
  }
  let calls = 0
  const service = { fetch: (request: Request) => {
    calls++
    return Promise.resolve(Response.json(new URL(request.url).pathname === '/v1/config' ? disabledConfiguration : { configuration: disabledConfiguration, cursor: null, bindings: [], events: [], projections: [] }))
  } } as Fetcher
  const request = async () => createWorkerApp().request('https://app.test/api/customer/chain/snapshot', { headers: { Cookie: `retempo_session=${token}` } }, { ...bindings, CHAIN: service })
  const response = await request()
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: { code: 'customer_snapshot_capacity' } })
  expect(calls).toBe(0)
  await bindings.DB.prepare("DELETE FROM wallets WHERE purpose='customer' AND org_id=?").bind(orgs.at(-1)!).run()
  const supported = await request()
  expect(supported.status).toBe(200)
  expect(calls).toBe(21)
})
