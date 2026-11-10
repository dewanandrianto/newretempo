import { env } from 'cloudflare:test'
import { describe, expect, test } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { recoverMessageAddress } from 'viem'
import { hashPassword, PASSWORD_ITERATIONS, verifyPassword } from '../src/auth/passwords'
import { createWorkerApp } from '../src/index'
import type { WorkerBindings } from '../src/types'

const bindings = env as unknown as WorkerBindings
const app = createWorkerApp()
async function request(path: string, body?: unknown, cookie?: string) {
  return app.request(`https://app.test/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: 'https://app.test', 'X-Requested-With': 'retempo', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.241', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, bindings)
}
function record(name: string, samplesMs: number[], extra: Record<string, unknown> = {}) {
  console.info('SECURITY_BENCH ' + JSON.stringify({ name, runtime: 'local-workerd', metric: 'elapsed-wall-ms-not-production-cpu', samplesMs, productionCpuVerified: false, ...extra }))
}
async function timed<T>(samples: number[], work: () => Promise<T>): Promise<T> {
  const start = performance.now()
  const result = await work()
  samples.push(performance.now() - start)
  return result
}

describe('bounded local real-workerd authentication cost evidence', () => {
  test('measures unchanged native KDF hash and correct/incorrect verification', async () => {
    const hashes: number[] = [], correct: number[] = [], incorrect: number[] = []
    for (let i = 0; i < 3; i++) {
      const hash = await timed(hashes, () => hashPassword('benchmark-only ephemeral password'))
      expect(await timed(correct, () => verifyPassword('benchmark-only ephemeral password', hash))).toBe(true)
      expect(await timed(incorrect, () => verifyPassword('wrong benchmark password', hash))).toBe(false)
    }
    record('pbkdf2-hash', hashes, { iterations: PASSWORD_ITERATIONS })
    record('pbkdf2-verify-correct', correct, { iterations: PASSWORD_ITERATIONS })
    record('pbkdf2-verify-incorrect', incorrect, { iterations: PASSWORD_ITERATIONS })
    expect(PASSWORD_ITERATIONS).toBe(600000)
  })
  test('measures EOA recovery and complete signed SIWE/D1/session requests', async () => {
    const recovery: number[] = [], login: number[] = []
    for (let i = 0; i < 6; i++) {
      const account = privateKeyToAccount(generatePrivateKey())
      const nonce = await request('auth/siwe/nonce', { address: account.address })
      expect(nonce.status).toBe(200)
      const { message } = await nonce.json<{ message: string }>()
      const signature = await account.signMessage({ message })
      expect((await timed(recovery, () => recoverMessageAddress({ message, signature }))).toLowerCase()).toBe(account.address.toLowerCase())
      const response = await timed(login, () => request('auth/siwe/verify', { message, signature }))
      expect(response.status).toBe(200)
      const cookie = response.headers.get('set-cookie')!.split(';')[0]
      expect((await request('auth/me', undefined, cookie)).status).toBe(200)
      expect((await request('auth/logout', {}, cookie)).status).toBe(200)
      expect((await request('auth/me', undefined, cookie)).status).toBe(401)
      expect((await request('auth/siwe/verify', { message, signature })).status).toBe(401)
    }
    record('siwe-eoa-recovery', recovery)
    record('siwe-http-d1-session', login, { signedLogins: 6, replayDenied: 6, logoutRevocationsVerified: 6 })
  })
  test('bounds a concurrent invalid-password burst with a D1 atomic email rate limit', async () => {
    const samples: number[] = []
    const email = `cost-${crypto.randomUUID()}@example.test`
    const responses = await Promise.all(Array.from({ length: 10 }, () => timed(samples, () => request('auth/login', { email, password: 'incorrect test password' }))))
    const statuses = responses.map(response => response.status).sort()
    expect(statuses.filter(status => status === 401)).toHaveLength(8)
    expect(statuses.filter(status => status === 429)).toHaveLength(2)
    expect(await bindings.DB.prepare('SELECT count FROM rate_limits WHERE key=?').bind(`login:email:${email}`).first('count')).toBe(10)
    record('invalid-password-burst', samples, { concurrency: 10, statuses, maxKdfInvocations: 8, externalFetches: 0 })
  })
})
