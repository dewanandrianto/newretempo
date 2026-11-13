import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { LoginInput, OrganizationInput, Session, SignUpInput } from '@shared/types'
import { auth } from '@/services/auth'
import { setActiveOrg } from '@/services/api/activeOrg'
import { usePrivyLogout, useRuntimeAuthConfig } from './privyRuntimeContext'

type Status = 'loading' | 'ready'

export interface AuthSessionContext {
  userId: string
  organizationId: string | null
  revision: number
}

interface AuthContextValue {
  status: Status
  session: Session | null
  sessionRevision: number
  privyEnabled: boolean
  signUp: (input: SignUpInput) => Promise<{ verificationEmailSent: boolean }>
  logIn: (input: LoginInput) => Promise<Session>
  logInWithPrivy: (accessToken: string) => Promise<Session>
  linkPrivyAccount: (accessToken: string) => Promise<void>
  verifyPrivyWalletAccess: (accessToken: string) => Promise<{ allowed: boolean }>
  requestWalletChallenge: (address: `0x${string}`) => Promise<{ message: string }>
  verifyWalletSignature: (input: { message: string; signature: `0x${string}` }) => Promise<Session>
  requestWalletLinkChallenge: (address: `0x${string}`, expected: AuthSessionContext) => Promise<{ message: string; expiresAt: string }>
  verifyWalletLinkSignature: (input: { message: string; signature: `0x${string}` }, expected: AuthSessionContext) => Promise<Session>
  requestMerchantWalletChallenge: (orgId: string, address: `0x${string}`, expected: AuthSessionContext) => Promise<{ message: string; expiresAt: string }>
  verifyMerchantWalletSignature: (orgId: string, input: { message: string; signature: `0x${string}` }, expected: AuthSessionContext) => Promise<Session>
  getSessionContext: () => AuthSessionContext | null
  assertSessionContext: (expected: AuthSessionContext) => void
  createOrganization: (input: OrganizationInput) => Promise<Session>
  refresh: () => Promise<Session | null>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)
const AUTH_SYNC_CHANNEL = 'retempo-auth-session'
const AUTH_SYNC_STORAGE_KEY = 'retempo.auth-session-changed'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [session, setSession] = useState<Session | null>(null)
  const [sessionRevision, setSessionRevision] = useState(0)
  const sessionRevisionRef = useRef(0)
  const queryClient = useQueryClient()
  const runtimeConfig = useRuntimeAuthConfig()
  const logoutPrivy = usePrivyLogout()
  const channelRef = useRef<BroadcastChannel | null>(null)
  const syncVersionRef = useRef(0)
  const signOutRequestVersionRef = useRef<number | null>(null)
  const sessionRef = useRef<Session | null>(null)
  const initialReadyRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  const refreshFromAnotherTabRef = useRef<(() => Promise<void>) | null>(null)
  const initialLoadVersionRef = useRef(0)

  const bumpSessionRevision = useCallback(() => {
    sessionRevisionRef.current += 1
    setSessionRevision(sessionRevisionRef.current)
  }, [])

  // Keeps the API layer's organization scope in lockstep with the session.
  const commit = useCallback((next: Session | null) => {
    setActiveOrg(next?.organization ? { id: next.organization.id, name: next.organization.name } : null)
    sessionRef.current = next
    setSession(next)
    return next
  }, [])

  const notifySessionChanged = useCallback(() => {
    channelRef.current?.postMessage('session-changed')
    try {
      window.localStorage.setItem(AUTH_SYNC_STORAGE_KEY, `${Date.now()}-${Math.random()}`)
    } catch {
      // BroadcastChannel remains the primary path when local storage is unavailable.
    }
  }, [])

  const commitAuthenticated = useCallback((next: Session) => {
    syncVersionRef.current += 1
    bumpSessionRevision()
    queryClient.clear()
    commit(next)
    setStatus('ready')
    notifySessionChanged()
    return next
  }, [bumpSessionRevision, commit, notifySessionChanged, queryClient])

  const getSessionContext = useCallback((): AuthSessionContext | null => {
    const current = sessionRef.current
    return current ? { userId: current.user.id, organizationId: current.organization?.id ?? null, revision: sessionRevisionRef.current } : null
  }, [])

  const assertSessionContext = useCallback((expected: AuthSessionContext) => {
    const current = sessionRef.current
    if (signOutRequestVersionRef.current !== null || !current || sessionRevisionRef.current !== expected.revision || current.user.id !== expected.userId || (current.organization?.id ?? null) !== expected.organizationId) {
      throw new Error('The active account, organization, or session changed during wallet verification. No login switch was performed.')
    }
  }, [])

  const commitLinkedWallet = useCallback((next: Session, expected: AuthSessionContext) => {
    const current = sessionRef.current
    assertSessionContext(expected)
    if (!current || next.user.id !== current.user.id || (next.organization?.id ?? null) !== (current.organization?.id ?? null)) {
      throw new Error('Wallet verification returned a different account or organization. The current session was kept unchanged.')
    }
    commit(next)
    void queryClient.invalidateQueries()
    return next
  }, [assertSessionContext, commit, queryClient])

  useEffect(() => {
    const requestVersion = ++initialLoadVersionRef.current
    const sessionVersion = syncVersionRef.current
    auth
      .loadSession()
      .then((current) => {
        if (
          initialLoadVersionRef.current === requestVersion &&
          sessionVersion === syncVersionRef.current &&
          !pendingRefreshRef.current
        ) commit(current)
      })
      .catch(() => {
        if (
          initialLoadVersionRef.current === requestVersion &&
          sessionVersion === syncVersionRef.current &&
          !pendingRefreshRef.current
        ) commit(null)
      })
      .finally(() => {
        if (initialLoadVersionRef.current === requestVersion) {
          initialReadyRef.current = true
          setStatus('ready')
          if (pendingRefreshRef.current) {
            pendingRefreshRef.current = false
            void refreshFromAnotherTabRef.current?.()
          }
        }
      })
    return () => {
      if (initialLoadVersionRef.current === requestVersion) initialLoadVersionRef.current += 1
    }
  }, [commit])

  const refreshFromAnotherTab = useCallback(async () => {
    if (signOutRequestVersionRef.current !== null) return
    if (!initialReadyRef.current) {
      pendingRefreshRef.current = true
      return
    }
    const version = ++syncVersionRef.current
    const previousScope = `${sessionRef.current?.user.id ?? ''}\u0000${sessionRef.current?.organization?.id ?? ''}`
    setStatus('loading')
    try {
      const next = await auth.loadSession()
      if (version !== syncVersionRef.current) return
      const nextScope = `${next?.user.id ?? ''}\u0000${next?.organization?.id ?? ''}`
      if (previousScope !== nextScope) {
        queryClient.clear()
        bumpSessionRevision()
      }
      if (version === syncVersionRef.current) commit(next)
    } catch {
      // A network/server error is not proof that the existing session is invalid.
    } finally {
      if (version === syncVersionRef.current) setStatus('ready')
    }
  }, [bumpSessionRevision, commit, queryClient])

  useEffect(() => {
    refreshFromAnotherTabRef.current = refreshFromAnotherTab
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTH_SYNC_STORAGE_KEY) void refreshFromAnotherTab()
    }
    const onChannelMessage = (event: MessageEvent<unknown>) => {
      if (event.data === 'session-changed') void refreshFromAnotherTab()
    }
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refreshFromAnotherTab()
    }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(AUTH_SYNC_CHANNEL)
    channelRef.current = channel
    channel?.addEventListener('message', onChannelMessage)
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', onFocus)
    return () => {
      if (refreshFromAnotherTabRef.current === refreshFromAnotherTab) refreshFromAnotherTabRef.current = null
      channel?.removeEventListener('message', onChannelMessage)
      channel?.close()
      if (channelRef.current === channel) channelRef.current = null
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', onFocus)
    }
  }, [refreshFromAnotherTab])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      sessionRevision,
      privyEnabled: runtimeConfig.enabled,
      signUp: async (input) => {
        const res = await auth.signUp(input)
        commitAuthenticated(res.session)
        return { verificationEmailSent: res.verificationEmailSent }
      },
      logIn: async (input) => commitAuthenticated(await auth.logIn(input)),
      logInWithPrivy: async (accessToken) => commitAuthenticated(await auth.logInWithPrivy(accessToken)),
      linkPrivyAccount: (accessToken) => auth.linkPrivyAccount(accessToken),
      verifyPrivyWalletAccess: (accessToken) => auth.verifyPrivyWalletAccess(accessToken),
      requestWalletChallenge: (address) => auth.requestWalletChallenge(address),
      verifyWalletSignature: async (input) => commitAuthenticated(await auth.verifyWalletSignature(input)),
      getSessionContext,
      assertSessionContext,
      requestWalletLinkChallenge: async (address, expected) => {
        assertSessionContext(expected)
        const challenge = await auth.requestWalletLinkChallenge(address)
        assertSessionContext(expected)
        return challenge
      },
      verifyWalletLinkSignature: async (input, expected) => {
        assertSessionContext(expected)
        return commitLinkedWallet(await auth.verifyWalletLinkSignature(input), expected)
      },
      requestMerchantWalletChallenge: async (orgId, address, expected) => {
        assertSessionContext(expected)
        if (expected.organizationId !== orgId) throw new Error('The active organization changed. Reopen the current workspace before verifying its merchant wallet.')
        const challenge = await auth.requestMerchantWalletChallenge(orgId, address)
        assertSessionContext(expected)
        return challenge
      },
      verifyMerchantWalletSignature: async (orgId, input, expected) => {
        assertSessionContext(expected)
        if (expected.organizationId !== orgId) throw new Error('The active organization changed. Reopen the current workspace before verifying its merchant wallet.')
        return commitLinkedWallet(await auth.verifyMerchantWalletSignature(orgId, input), expected)
      },
      createOrganization: async (input) => {
        if (signOutRequestVersionRef.current !== null) throw new Error('Sign-out is in progress.')
        const requestVersion = ++syncVersionRef.current
        const created = await auth.createOrganization(input)
        if (requestVersion !== syncVersionRef.current) {
          if (signOutRequestVersionRef.current !== null) throw new Error('Sign-out is in progress.')
          const current = sessionRef.current
          if (!current || current.user.id !== created.user.id) throw new Error('Session changed during organization setup.')
          return current
        }
        queryClient.clear()
        commit(created)
        notifySessionChanged()
        return created
      },
      refresh: async () => {
        if (signOutRequestVersionRef.current !== null) throw new Error('Sign-out is in progress.')
        const requestVersion = ++syncVersionRef.current
        try {
          const next = await auth.loadSession()
          if (requestVersion !== syncVersionRef.current) return sessionRef.current
          const current = sessionRef.current
          const currentScope = `${current?.user.id ?? ''}\u0000${current?.organization?.id ?? ''}`
          const nextScope = `${next?.user.id ?? ''}\u0000${next?.organization?.id ?? ''}`
          if (currentScope !== nextScope) {
            queryClient.clear()
            bumpSessionRevision()
          }
          return commit(next)
        } catch (error) {
          if (requestVersion !== syncVersionRef.current) return sessionRef.current
          throw error
        }
      },
      signOut: async () => {
        const requestVersion = ++syncVersionRef.current
        signOutRequestVersionRef.current = requestVersion
        bumpSessionRevision()
        try {
          await auth.signOut()
        } finally {
          try {
            if (requestVersion === syncVersionRef.current) await logoutPrivy()
          } finally {
            if (requestVersion === syncVersionRef.current) {
              syncVersionRef.current += 1
              queryClient.clear() // never keep one account's data in memory for the next
              commit(null)
              setStatus('ready')
              notifySessionChanged()
            }
            if (signOutRequestVersionRef.current === requestVersion) signOutRequestVersionRef.current = null
          }
        }
      },
    }),
    [status, session, sessionRevision, commit, commitAuthenticated, commitLinkedWallet, getSessionContext, assertSessionContext, bumpSessionRevision, queryClient, runtimeConfig.enabled, logoutPrivy, notifySessionChanged],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
