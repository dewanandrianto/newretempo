import { PG, pgCode, withTx } from '../db/client'
import { conflict, unauthorized, unavailable } from '../http/errors'
import type { Ctx } from '../http/types'
import { audit } from '../services/audit'
import { consumeEmailToken, issueEmailToken } from './emailTokens'
import { assertPasswordPolicy, hashPassword, verifyAgainstDummy, verifyPassword } from './passwords'
import { revokeAllSessions } from './sessions'

const MINUTE = 60_000

function baseUrl(ctx: Ctx): string {
  return (ctx.deps.config.appOrigins[0] ?? ctx.deps.config.siwe.uri).replace(/\/$/, '')
}

/** Sends a one-time link. Tokens travel in the URL fragment so they never reach server logs or Referer headers. */
async function sendLink(ctx: Ctx, userId: string, email: string, purpose: 'verify_email' | 'reset_password'): Promise<boolean> {
  const { db, config, mailer } = ctx.deps
  if (!mailer.configured) return false
  const token = await issueEmailToken(db, config.sessionSecret, userId, email, purpose)
  const path = purpose === 'verify_email' ? '/verify-email' : '/reset-password'
  try {
    await mailer.send({
      to: email,
      kind: purpose,
      subject: purpose === 'verify_email' ? 'Verify your RETEMPO email' : 'Reset your RETEMPO password',
      link: `${baseUrl(ctx)}${path}#${token}`,
    })
    return true
  } catch (err) {
    console.error(`[email] failed to send ${purpose}:`, err instanceof Error ? err.message : 'unknown error')
    return false
  }
}

export async function registerUser(
  ctx: Ctx,
  input: { email: string; password: string; name: string },
): Promise<{ userId: string; verificationEmailSent: boolean }> {
  const { db, mailer, limiter } = ctx.deps
  limiter.consume(`register:ip:${ctx.ip}`, 10, 60 * MINUTE)
  // Fail safely: never create an account whose verification email can never be delivered.
  if (!mailer.configured) throw unavailable('Email delivery is not configured, so new accounts cannot be created right now', 'email_not_configured')
  assertPasswordPolicy(input.password, input.email)

  const passwordHash = await hashPassword(input.password)
  let userId: string
  try {
    userId = await withTx(db, async (tx) => {
      const rows = (await tx`
        INSERT INTO users (email, password_hash, display_name)
        VALUES (${input.email}, ${passwordHash}, ${input.name})
        RETURNING id`) as { id: string }[]
      const id = rows[0].id
      await audit(tx, ctx, { actorUserId: id, action: 'user.registered', resourceType: 'user', resourceId: id })
      return id
    })
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('An account with this email already exists', 'email_taken')
    throw err
  }
  const sent = await sendLink(ctx, userId, input.email, 'verify_email')
  return { userId, verificationEmailSent: sent }
}

export async function authenticatePassword(ctx: Ctx, input: { email: string; password: string }): Promise<string> {
  const { db, limiter } = ctx.deps
  limiter.consume(`login:ip:${ctx.ip}`, 20, 15 * MINUTE)
  limiter.consume(`login:email:${input.email}`, 8, 15 * MINUTE)

  const rows = (await db`
    SELECT id, password_hash, status FROM users WHERE email = ${input.email}`) as {
    id: string
    password_hash: string | null
    status: string
  }[]
  const user = rows[0]
  const valid = user?.password_hash ? await verifyPassword(input.password, user.password_hash) : (await verifyAgainstDummy(input.password), false)
  if (!user || !valid || user.status !== 'active') {
    await audit(db, ctx, { actorUserId: user?.id ?? null, action: 'auth.login_failed', resourceType: 'user', resourceId: user?.id ?? null })
    throw unauthorized('Invalid email or password')
  }
  await db`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`
  await audit(db, ctx, { actorUserId: user.id, action: 'auth.login', resourceType: 'user', resourceId: user.id, metadata: { method: 'password' } })
  return user.id
}

export async function verifyEmail(ctx: Ctx, token: string): Promise<void> {
  const { db, config, limiter } = ctx.deps
  limiter.consume(`verify:ip:${ctx.ip}`, 20, 10 * MINUTE)
  const consumed = await consumeEmailToken(db, config.sessionSecret, token, 'verify_email')
  if (!consumed) throw unauthorized('This verification link is invalid or has expired')
  const rows = await db`
    UPDATE users SET email_verified_at = now()
    WHERE id = ${consumed.userId} AND email = ${consumed.email} AND email_verified_at IS NULL
    RETURNING id`
  if (rows.length) await audit(db, ctx, { actorUserId: consumed.userId, action: 'user.email_verified', resourceType: 'user', resourceId: consumed.userId })
}

export async function resendVerification(ctx: Ctx, userId: string, email: string | null, alreadyVerified: boolean): Promise<boolean> {
  ctx.deps.limiter.consume(`resend:user:${userId}`, 3, 30 * MINUTE)
  if (!email || alreadyVerified) return false
  if (!ctx.deps.mailer.configured) throw unavailable('Email delivery is not configured on this server', 'email_not_configured')
  return sendLink(ctx, userId, email, 'verify_email')
}

export async function requestPasswordReset(ctx: Ctx, email: string): Promise<void> {
  const { db, limiter, mailer } = ctx.deps
  limiter.consume(`forgot:ip:${ctx.ip}`, 10, 60 * MINUTE)
  limiter.consume(`forgot:email:${email}`, 3, 60 * MINUTE)
  if (!mailer.configured) throw unavailable('Email delivery is not configured on this server', 'email_not_configured')
  const rows = (await db`SELECT id FROM users WHERE email = ${email} AND status = 'active'`) as { id: string }[]
  if (rows[0]) {
    await sendLink(ctx, rows[0].id, email, 'reset_password')
    await audit(db, ctx, { actorUserId: rows[0].id, action: 'auth.password_reset_requested', resourceType: 'user', resourceId: rows[0].id })
  }
  // Same response whether or not the account exists.
}

export async function resetPassword(ctx: Ctx, token: string, password: string): Promise<void> {
  const { db, config, limiter } = ctx.deps
  limiter.consume(`reset:ip:${ctx.ip}`, 10, 60 * MINUTE)
  assertPasswordPolicy(password)
  const hash = await hashPassword(password)
  await withTx(db, async (tx) => {
    const consumed = await consumeEmailToken(tx, config.sessionSecret, token, 'reset_password')
    if (!consumed) throw unauthorized('This reset link is invalid or has expired')
    const rows = await tx`
      UPDATE users SET password_hash = ${hash}, email_verified_at = coalesce(email_verified_at, now())
      WHERE id = ${consumed.userId} AND email = ${consumed.email} AND status = 'active'
      RETURNING id`
    if (!rows.length) throw unauthorized('This reset link is invalid or has expired')
    // A reset invalidates every existing session for the account.
    await revokeAllSessions(tx, consumed.userId, 'password_reset')
    await audit(tx, ctx, { actorUserId: consumed.userId, action: 'auth.password_reset', resourceType: 'user', resourceId: consumed.userId })
  })
}
