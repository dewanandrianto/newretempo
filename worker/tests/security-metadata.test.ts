import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { createWorkerApp } from '../src/index'

test('disabled public chain metadata uses the official Arc Testnet endpoints without enabling writes', async () => {
  const response = await createWorkerApp().request('https://app.test/api/chain/config', {}, { ...env, CHAIN: undefined })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ chainId: 5042002, rpcUrl: 'https://rpc.blockdaemon.testnet.arc.io', explorerUrl: 'https://explorer.testnet.arc.io', configured: false, mode: 'disabled', manager: null, escrow: null })
})
