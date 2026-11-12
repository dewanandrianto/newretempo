import { describe, expect, it, vi } from 'vitest'
import {
  canFinalizePrivyCompletion,
  getAuthenticatedPrivyAccessToken,
} from '../../src/features/auth/privyAccessToken'

describe('Privy client access token retrieval', () => {
  it('waits for ready and authenticated state before requesting a token', async () => {
    const getAccessToken = vi.fn(() => Promise.resolve('synthetic-access-token'))

    expect(canFinalizePrivyCompletion({ ready: false, authenticated: false, mode: 'login' })).toBe(false)
    expect(canFinalizePrivyCompletion({ ready: true, authenticated: false, mode: 'login' })).toBe(false)
    expect(canFinalizePrivyCompletion({ ready: true, authenticated: true, mode: 'login' })).toBe(true)
    expect(canFinalizePrivyCompletion({ ready: true, authenticated: false, mode: 'wallet' })).toBe(true)

    await expect(getAuthenticatedPrivyAccessToken({ ready: false, authenticated: true, getAccessToken }))
      .rejects.toMatchObject({ code: 'privy_not_ready' })
    await expect(getAuthenticatedPrivyAccessToken({ ready: true, authenticated: false, getAccessToken }))
      .rejects.toMatchObject({ code: 'privy_not_authenticated' })
    expect(getAccessToken).not.toHaveBeenCalled()
  })

  it('returns the token for a ready, authenticated SDK state', async () => {
    const getAccessToken = vi.fn(() => Promise.resolve('synthetic-access-token'))

    await expect(getAuthenticatedPrivyAccessToken({ ready: true, authenticated: true, getAccessToken }))
      .resolves.toBe('synthetic-access-token')
    expect(getAccessToken).toHaveBeenCalledTimes(1)
  })

  it('distinguishes a missing token from a rejected SDK call', async () => {
    await expect(getAuthenticatedPrivyAccessToken({
      ready: true,
      authenticated: true,
      getAccessToken: () => Promise.resolve(null),
    })).rejects.toMatchObject({ code: 'token_missing' })

    await expect(getAuthenticatedPrivyAccessToken({
      ready: true,
      authenticated: true,
      getAccessToken: () => Promise.reject(new Error('raw SDK details must stay private')),
    })).rejects.toMatchObject({
      code: 'token_fetch_failed',
      message: 'Could not retrieve the Privy sign-in token.',
    })
  })
})
