export type PrivyCompletionMode = 'login' | 'link' | 'wallet'
export type PrivyAccessTokenErrorCode = 'privy_not_ready' | 'privy_not_authenticated' | 'token_missing' | 'token_fetch_failed'

export type PrivyLoginSelection = {
  loginMethod: string | null
  /** Linked-account metadata is optional and is never used as wallet-control proof. */
  loginAccount?: unknown
}

const SUPPORTED_PRIVY_LOGIN_METHODS = new Set(['email', 'google', 'twitter', 'siwe', 'wallet'])

export function resolvePrivyLoginSelection(
  selection: PrivyLoginSelection | null | undefined,
): { kind: 'continue' } | { kind: 'invalid'; code: 'login_selection_invalid' } {
  if (!selection) return { kind: 'invalid', code: 'login_selection_invalid' }
  if (selection.loginMethod === null || SUPPORTED_PRIVY_LOGIN_METHODS.has(selection.loginMethod)) {
    return { kind: 'continue' }
  }
  return { kind: 'invalid', code: 'login_selection_invalid' }
}

export class PrivyAccessTokenError extends Error {
  constructor(readonly code: PrivyAccessTokenErrorCode) {
    super('Could not retrieve the Privy sign-in token.')
    this.name = 'PrivyAccessTokenError'
  }
}

export function canFinalizePrivyCompletion({
  ready,
  authenticated,
  mode,
}: {
  ready: boolean
  authenticated: boolean
  mode: PrivyCompletionMode
}): boolean {
  return ready && (mode === 'wallet' || authenticated)
}

export async function getAuthenticatedPrivyAccessToken({
  ready,
  authenticated,
  getAccessToken,
}: {
  ready: boolean
  authenticated: boolean
  getAccessToken: () => Promise<string | null>
}): Promise<string> {
  if (!ready) throw new PrivyAccessTokenError('privy_not_ready')
  if (!authenticated) throw new PrivyAccessTokenError('privy_not_authenticated')

  let accessToken: string | null
  try {
    accessToken = await getAccessToken()
  } catch {
    // Never surface or log raw SDK exceptions, which may include sensitive context.
    throw new PrivyAccessTokenError('token_fetch_failed')
  }

  if (!accessToken) throw new PrivyAccessTokenError('token_missing')
  return accessToken
}
