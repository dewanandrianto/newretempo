import { describe, expect, it, vi } from 'vitest'
import { startOrJoinVersionedRequest, type VersionedRequest } from '../../src/features/auth/PrivyAccessRequest'

describe('startOrJoinVersionedRequest', () => {
  it('joins a pending check for the same account and Privy identity', async () => {
    const requests = new Map<string, VersionedRequest<boolean>>()
    const version = { current: 0 }
    let resolveCheck!: (value: boolean) => void
    const work = vi.fn(() => new Promise<boolean>((resolve) => { resolveCheck = resolve }))

    const first = startOrJoinVersionedRequest(requests, version, 'account-a\u0000did-a', work)
    const second = startOrJoinVersionedRequest(requests, version, 'account-a\u0000did-a', work)
    await Promise.resolve()

    expect(second).toBe(first)
    expect(version.current).toBe(1)
    expect(work).toHaveBeenCalledTimes(1)
    resolveCheck(true)
    await expect(first).resolves.toBe(true)
    expect(requests.size).toBe(0)
  })

  it('fences an older identity check and preserves a newer request during cleanup', async () => {
    const requests = new Map<string, VersionedRequest<boolean>>()
    const version = { current: 0 }
    let resolveOld!: (value: boolean) => void
    let resolveCurrent!: (value: boolean) => void
    let resolveReplacement!: (value: boolean) => void
    const old = startOrJoinVersionedRequest(requests, version, 'account-a\u0000did-a', () =>
      new Promise<boolean>((resolve) => { resolveOld = resolve }),
    )
    const current = startOrJoinVersionedRequest(requests, version, 'account-b\u0000did-b', () =>
      new Promise<boolean>((resolve) => { resolveCurrent = resolve }),
    )
    const replacement = startOrJoinVersionedRequest(requests, version, 'account-a\u0000did-a', () =>
      new Promise<boolean>((resolve) => { resolveReplacement = resolve }),
    )
    await Promise.resolve()

    expect(version.current).toBe(3)
    expect(requests.get('account-a\u0000did-a')?.promise).toBe(replacement)
    resolveOld(true)
    await expect(old).resolves.toBe(true)
    expect(requests.get('account-a\u0000did-a')?.promise).toBe(replacement)
    resolveCurrent(true)
    await expect(current).resolves.toBe(true)
    resolveReplacement(true)
    await expect(replacement).resolves.toBe(true)
    expect(requests.size).toBe(0)
  })
})
