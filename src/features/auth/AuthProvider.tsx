import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { LoginInput, OrganizationInput, Session, SignUpInput } from '@shared/types'
import { auth } from '@/services/auth'
import { setActiveOrg } from '@/services/api/activeOrg'
import { usePrivyLogout, useRuntimeAuthConfig } from './privyRuntimeContext'

type Status = 'loading' | 'ready'

interface AuthContextValue {
  status: Status
  session: Session | null
  privyEnabled: boolean
  signUp: (input: SignUpInput) => Promise<{ verificationEmailSent: boolean }>
  logIn: (input: LoginInput) => Promise<Session>
  logInWithPrivy: (accessToken: string) => Promise<Session>
  linkPrivyAccount: (accessToken: string) => Promise<void>
  requestWalletChallenge: (address: `0x${string}`) => Promise<{ message: string }>
  verifyWalletSignature: (input: { message: string; signature: `0x${string}` }) => Promise<Session>
  createOrganization: (input: OrganizationInput) => Promise<Session>
  refresh: () => Promise<Session | null>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [session, setSession] = useState<Session | null>(null)
  const queryClient = useQueryClient()
  const runtimeConfig = useRuntimeAuthConfig()
  const logoutPrivy = usePrivyLogout()

  // Keeps the API layer's organization scope in lockstep with the session.
  const commit = useCallback((next: Session | null) => {
    setActiveOrg(next?.organization ? { id: next.organization.id, name: next.organization.name } : null)
    setSession(next)
    return next
  }, [])

  useEffect(() => {
    let cancelled = false
    auth
      .loadSession()
      .then((s) => {
        if (!cancelled) commit(s)
      })
      .catch(() => {
        if (!cancelled) commit(null)
      })
      .finally(() => {
        if (!cancelled) setStatus('ready')
      })
    return () => {
      cancelled = true
    }
  }, [commit])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      privyEnabled: runtimeConfig.enabled,
      signUp: async (input) => {
        const res = await auth.signUp(input)
        commit(res.session)
        return { verificationEmailSent: res.verificationEmailSent }
      },
      logIn: async (input) => commit(await auth.logIn(input)) as Session,
      logInWithPrivy: async (accessToken) => commit(await auth.logInWithPrivy(accessToken)) as Session,
      linkPrivyAccount: (accessToken) => auth.linkPrivyAccount(accessToken),
      requestWalletChallenge: (address) => auth.requestWalletChallenge(address),
      verifyWalletSignature: async (input) => commit(await auth.verifyWalletSignature(input)) as Session,
      createOrganization: async (input) => commit(await auth.createOrganization(input)) as Session,
      refresh: async () => commit(await auth.loadSession()),
      signOut: async () => {
        try {
          await auth.signOut()
        } finally {
          try { await logoutPrivy() } finally {
            queryClient.clear() // never keep one account's data in memory for the next
            commit(null)
          }
        }
      },
    }),
    [status, session, commit, queryClient, runtimeConfig.enabled, logoutPrivy],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
