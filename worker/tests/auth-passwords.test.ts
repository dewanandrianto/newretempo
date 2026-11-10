import { describe, it, expect } from 'vitest'
import { cpuUsage } from 'node:process'
import { hashPassword, verifyPassword } from '../src/auth/passwords'

describe('Workers password security', () => {
  it('runs PBKDF2 SHA-256 at 600000 iterations in real workerd', async () => {
    const start = performance.now()
    let before: ReturnType<typeof cpuUsage> | undefined
    try { before = cpuUsage() } catch { console.info('workerd does not expose process CPU accounting; provider CPU metrics remain required') }
    const hash = await hashPassword('a long unique password')
    if (before) console.info('PBKDF2 process CPU microseconds:', cpuUsage(before))
    console.info('PBKDF2 600000 wall milliseconds:', performance.now() - start)
    expect(hash.startsWith('pbkdf2-sha256$600000$')).toBe(true)
    expect(await verifyPassword('a long unique password', hash)).toBe(true)
    expect(await verifyPassword('incorrect', hash)).toBe(false)
  })
})
