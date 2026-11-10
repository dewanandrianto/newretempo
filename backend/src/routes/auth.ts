import { z } from 'zod'
import {
  authenticatePassword,
  registerUser,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  verifyEmail,
} from '../auth/service'
import { establishSession, expireCookie, revokeSession } from '../auth/sessions'
import { issueChallenge, verifyChallenge } from '../auth/siwe'
import { linkWalletToUser, loginWithWallet } from '../auth/walletAuth'
import { requireAuth } from '../http/guards'
import type { Router } from '../http/router'
import type { Ctx } from '../http/types'
import { created } from '../http/types'
import { audit } from '../services/audit'
import { loadAccount } from '../services/account'

const email = z.string().trim().toLowerCase().max(254).pipe(z.email())
const address = z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, 'Enter a valid wallet address')
const token = z.string().min(20).max(200)

const registerBody = z.object({
  email,
  password: z.string().min(1).max(128),
  name: z.string().trim().min(1, 'Enter your name').max(80),
})
const loginBody = z.object({ email, password: z.string().min(1).max(128) })
const siweNonceBody = z.object({ address })
const siweVerifyBody = z.object({ message: z.string().min(1).max(2000), signature: z.string().min(1).max(300) })

async function accountResponse(ctx: Ctx) {
  const auth = requireAuth(ctx)
  return {
    ...(await loadAccount(ctx.deps.db, auth.userId)),
    session: { method: auth.method },
    policy: { requireVerifiedEmail: ctx.deps.config.requireVerifiedEmail },
  }
}

export function authRoutes(r: Router): void {
  r.get('/api/health', () => Promise.resolve({ status: 'ok' }))

  r.get('/api/auth/me', (ctx) => accountResponse(ctx))

  r.post('/api/auth/register', async (ctx) => {
    const input = await ctx.body(registerBody)
    const { userId, verificationEmailSent } = await registerUser(ctx, input)
    await establishSession(ctx, userId, 'password')
    ctx.auth = { sessionId: '', userId, method: 'password', user: { id: userId, email: input.email, emailVerified: false, displayName: input.name } }
    return created({ ...(await accountResponse(ctx)), verificationEmailSent })
  })

  r.post('/api/auth/login', async (ctx) => {
    const input = await ctx.body(loginBody)
    const userId = await authenticatePassword(ctx, input)
    await establishSession(ctx, userId, 'password')
    ctx.auth = { sessionId: '', userId, method: 'password', user: { id: userId, email: input.email, emailVerified: false, displayName: '' } }
    return accountResponse(ctx)
  })

  r.post('/api/auth/logout', async (ctx) => {
    if (ctx.auth) {
      await revokeSession(ctx.deps.db, ctx.auth.sessionId, 'logout')
      await audit(ctx.deps.db, ctx, { actorUserId: ctx.auth.userId, action: 'auth.logout', resourceType: 'session', resourceId: ctx.auth.sessionId })
    }
    expireCookie(ctx)
    return { ok: true }
  })

  r.post('/api/auth/verify-email', async (ctx) => {
    const { token: t } = await ctx.body(z.object({ token }))
    await verifyEmail(ctx, t)
    return { ok: true }
  })

  r.post('/api/auth/resend-verification', async (ctx) => {
    const auth = requireAuth(ctx)
    const sent = await resendVerification(ctx, auth.userId, auth.user.email, auth.user.emailVerified)
    return { sent }
  })

  r.post('/api/auth/forgot-password', async (ctx) => {
    const { email: e } = await ctx.body(z.object({ email }))
    await requestPasswordReset(ctx, e)
    return { ok: true }
  })

  r.post('/api/auth/reset-password', async (ctx) => {
    const input = await ctx.body(z.object({ token, password: z.string().min(1).max(128) }))
    await resetPassword(ctx, input.token, input.password)
    expireCookie(ctx)
    return { ok: true }
  })

  r.post('/api/auth/siwe/nonce', async (ctx) => {
    const input = await ctx.body(siweNonceBody)
    ctx.deps.limiter.consume(`siwe:nonce:${ctx.ip}`, 30, 10 * 60_000)
    return issueChallenge(ctx.deps.db, ctx.deps.config, ctx.deps.now(), { address: input.address, purpose: 'login' })
  })

  r.post('/api/auth/siwe/verify', async (ctx) => {
    const input = await ctx.body(siweVerifyBody)
    ctx.deps.limiter.consume(`siwe:verify:${ctx.ip}`, 30, 10 * 60_000)
    const wallet = await verifyChallenge(ctx.deps.db, ctx.deps.config, ctx.deps.now(), { ...input, purpose: 'login' })
    const userId = await loginWithWallet(ctx, wallet)
    await establishSession(ctx, userId, 'siwe')
    ctx.auth = { sessionId: '', userId, method: 'siwe', user: { id: userId, email: null, emailVerified: false, displayName: '' } }
    return accountResponse(ctx)
  })

  r.post('/api/auth/siwe/link/nonce', async (ctx) => {
    const auth = requireAuth(ctx)
    const input = await ctx.body(siweNonceBody)
    ctx.deps.limiter.consume(`siwe:nonce:${ctx.ip}`, 30, 10 * 60_000)
    return issueChallenge(ctx.deps.db, ctx.deps.config, ctx.deps.now(), { address: input.address, purpose: 'link', userId: auth.userId })
  })

  r.post('/api/auth/siwe/link/verify', async (ctx) => {
    const auth = requireAuth(ctx)
    const input = await ctx.body(siweVerifyBody)
    const wallet = await verifyChallenge(ctx.deps.db, ctx.deps.config, ctx.deps.now(), { ...input, purpose: 'link' })
    await linkWalletToUser(ctx, wallet, auth.userId)
    return accountResponse(ctx)
  })
}
