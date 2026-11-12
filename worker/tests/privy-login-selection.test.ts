import { describe, expect, it, vi } from 'vitest'
import {
  canFinalizePrivyCompletion,
  getAuthenticatedPrivyAccessToken,
  resolvePrivyLoginSelection,
} from '../../src/features/auth/privyAccessToken'

describe('Privy login selection routing', () => {
  it.each(['email', 'google', 'twitter'])('uses verified Privy identity for %s even when callback includes wallet metadata', (loginMethod) => {
    const selection = resolvePrivyLoginSelection({
      loginMethod,
      loginAccount: { type: 'wallet', walletClientType: 'privy', address: '0x0000000000000000000000000000000000000001' },
    })

    expect(selection).toEqual({ kind: 'continue' })
  })

  it('accepts the installed SDK external-wallet method `siwe` when loginAccount is null', async () => {
    expect(resolvePrivyLoginSelection({ loginMethod: 'siwe', loginAccount: null })).toEqual({ kind: 'continue' })
    expect(canFinalizePrivyCompletion({ ready: true, authenticated: true, mode: 'login' })).toBe(true)

    const getAccessToken = vi.fn(() => Promise.resolve('synthetic-access-token'))
    await expect(getAuthenticatedPrivyAccessToken({ ready: true, authenticated: true, getAccessToken }))
      .resolves.toBe('synthetic-access-token')
    expect(getAccessToken).toHaveBeenCalledTimes(1)
  })

  it('does not require an embedded wallet to be present or already synchronized', () => {
    const beforeWalletIsAvailable = resolvePrivyLoginSelection({ loginMethod: 'email', loginAccount: null })
    const afterWalletMetadataAppears = resolvePrivyLoginSelection({
      loginMethod: 'email',
      loginAccount: { type: 'wallet', walletClientType: 'privy-v2', address: '0x0000000000000000000000000000000000000002' },
    })

    expect(beforeWalletIsAvailable).toEqual({ kind: 'continue' })
    expect(afterWalletMetadataAppears).toEqual(beforeWalletIsAvailable)
    expect(canFinalizePrivyCompletion({ ready: true, authenticated: true, mode: 'login' })).toBe(true)
  })

  it('accepts the legacy wallet label and the SDK-documented nullable login method', () => {
    expect(resolvePrivyLoginSelection({ loginMethod: 'wallet', loginAccount: null })).toEqual({ kind: 'continue' })
    expect(resolvePrivyLoginSelection({ loginMethod: null, loginAccount: null })).toEqual({ kind: 'continue' })
  })

  it('rejects only a missing or unsupported completion selection', () => {
    expect(resolvePrivyLoginSelection(undefined)).toEqual({ kind: 'invalid', code: 'login_selection_invalid' })
    expect(resolvePrivyLoginSelection({ loginMethod: 'not-a-supported-login-method' })).toEqual({ kind: 'invalid', code: 'login_selection_invalid' })
  })
})
