import type { Membership, Organization, Session } from '@shared/types'
import { ApiError, get, post, postWithBearer } from '@/services/api/client'
import type { AuthService } from './types'

interface AccountResponse {
  user: { id: string; email: string | null; emailVerified: boolean; displayName: string; wallets: { address: string }[] }
  memberships: Membership[]
  policy: { requireVerifiedEmail: boolean }
}

const ACTIVE_ORG_KEY = 'retempo.activeOrg'

function toSession(a: AccountResponse): Session {
  const stored = sessionStorage.getItem(ACTIVE_ORG_KEY)
  const active = a.memberships.find((m) => m.organization.id === stored) ?? a.memberships[0]
  return {
    user: {
      id: a.user.id,
      name: a.user.displayName,
      email: a.user.email,
      emailVerified: a.user.emailVerified,
      wallets: a.user.wallets.map((w) => w.address),
    },
    memberships: a.memberships,
    organization: active?.organization,
    role: active?.role,
    requireVerifiedEmail: a.policy.requireVerifiedEmail,
  }
}

export const apiAuthService: AuthService = {
  async loadSession() {
    try {
      return toSession(await get<AccountResponse>('/auth/me'))
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null
      throw err
    }
  },

  async signUp(input) {
    const res = await post<AccountResponse & { verificationEmailSent: boolean }>('/auth/register', input)
    return { session: toSession(res), verificationEmailSent: res.verificationEmailSent }
  },

  async logIn(input) {
    return toSession(await post<AccountResponse>('/auth/login', input))
  },

  async logInWithPrivy(accessToken) {
    return toSession(await postWithBearer<AccountResponse>('/auth/privy/login', accessToken))
  },

  async linkPrivyAccount(accessToken) {
    await postWithBearer('/auth/privy/link', accessToken)
  },

  verifyPrivyWalletAccess: (accessToken) => postWithBearer<{ allowed: boolean }>('/auth/privy/wallet-access', accessToken),

  privyLinkStatus: () => get<{ enabled: boolean; linked: boolean }>('/auth/privy/status'),

  async signOut() {
    await post('/auth/logout')
    sessionStorage.removeItem(ACTIVE_ORG_KEY)
  },

  requestWalletChallenge: (address) => post<{ message: string }>('/auth/siwe/nonce', { address }),

  async verifyWalletSignature(input) {
    return toSession(await post<AccountResponse>('/auth/siwe/verify', input))
  },

  requestWalletLinkChallenge: (address) => post<{ message: string; expiresAt: string }>('/auth/siwe/link/nonce', { address }),

  async verifyWalletLinkSignature(input) {
    return toSession(await post<AccountResponse>('/auth/siwe/link/verify', input))
  },

  requestMerchantWalletChallenge: (orgId, address) => post<{ message: string; expiresAt: string }>(`/orgs/${encodeURIComponent(orgId)}/merchant-wallet/nonce`, { address }),

  async verifyMerchantWalletSignature(orgId, input) {
    return toSession(await post<AccountResponse>(`/orgs/${encodeURIComponent(orgId)}/merchant-wallet/verify`, input))
  },

  async createOrganization(input) {
    const org = await post<Organization>('/orgs', input)
    sessionStorage.setItem(ACTIVE_ORG_KEY, org.id)
    return toSession(await get<AccountResponse>('/auth/me'))
  },

  async verifyEmail(token) {
    await post('/auth/verify-email', { token })
  },

  async resendVerification() {
    return (await post<{ sent: boolean }>('/auth/resend-verification')).sent
  },

  async requestPasswordReset(email) {
    await post('/auth/forgot-password', { email })
  },

  async resetPassword(token, password) {
    await post('/auth/reset-password', { token, password })
  },
}
