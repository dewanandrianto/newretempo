import type { Db } from '../db/client'
import { clearSessionCookie, parseCookies, sessionCookie, sessionCookieName } from '../http/cookies'
import type { AuthContext, Ctx } from '../http/types'
import { hmacHex, randomToken } from '../security/crypto'

const TOUCH_INTERVAL_SECONDS = 60

interface SessionRow {
  id: string
  user_id: string
  auth_method: 'password' | 'siwe'
  last_seen_fresh: boolean
  email: string | null
  email_verified_at: Date | null
  display_name: string
}

/** Reads the session cookie and resolves it to an authenticated user, or null. */
export async function resolveSession(ctx: Pick<Ctx, 'req' | 'deps'>): Promise<AuthContext | null> {
  const { config, db } = ctx.deps
  const token = parseCookies(ctx.req.headers.get('cookie'))[sessionCookieName(config)]
  if (!token || token.length > 200) return null

  const rows = (await db`
    SELECT s.id, s.user_id, s.auth_method,
           (s.last_seen_at > now() - make_interval(secs => ${TOUCH_INTERVAL_SECONDS})) AS last_seen_fresh,
           u.email, u.email_verified_at, u.display_name
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hmacHex(config.sessionSecret, token)}
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
      AND s.idle_expires_at > now()
      AND u.status = 'active'`) as SessionRow[]
  const row = rows[0]
  if (!row) return null

  if (!row.last_seen_fresh) {
    // Sliding idle timeout, never beyond the absolute expiry.
    await db`
      UPDATE sessions
      SET last_seen_at = now(),
          idle_expires_at = LEAST(expires_at, now() + make_interval(secs => ${config.sessionIdleMs / 1000}))
      WHERE id = ${row.id}`
  }
  return {
    sessionId: row.id,
    userId: row.user_id,
    method: row.auth_method,
    user: { id: row.user_id, email: row.email, emailVerified: row.email_verified_at !== null, displayName: row.display_name },
  }
}

export async function revokeSession(db: Db, sessionId: string, reason: string): Promise<void> {
  await db`UPDATE sessions SET revoked_at = now(), revoked_reason = ${reason} WHERE id = ${sessionId} AND revoked_at IS NULL`
}

export async function revokeAllSessions(db: Db, userId: string, reason: string, exceptSessionId?: string): Promise<void> {
  await db`
    UPDATE sessions SET revoked_at = now(), revoked_reason = ${reason}
    WHERE user_id = ${userId} AND revoked_at IS NULL AND (${exceptSessionId ?? null}::uuid IS NULL OR id <> ${exceptSessionId ?? null}::uuid)`
}

/**
 * Starts a fresh session after authentication and rotates away any session the browser
 * already held (prevents session fixation). The raw token only ever travels in the cookie.
 */
export async function establishSession(
  ctx: Ctx,
  userId: string,
  method: 'password' | 'siwe',
): Promise<void> {
  const { config, db } = ctx.deps
  const previous = parseCookies(ctx.req.headers.get('cookie'))[sessionCookieName(config)]
  if (previous) {
    await db`
      UPDATE sessions SET revoked_at = now(), revoked_reason = 'rotated'
      WHERE token_hash = ${hmacHex(config.sessionSecret, previous)} AND revoked_at IS NULL`
  }
  const token = randomToken(32)
  await db`
    INSERT INTO sessions (user_id, token_hash, auth_method, ip, user_agent, idle_expires_at, expires_at)
    VALUES (${userId}, ${hmacHex(config.sessionSecret, token)}, ${method}, ${ctx.ip},
            ${ctx.req.headers.get('user-agent')?.slice(0, 300) ?? null},
            now() + make_interval(secs => ${config.sessionIdleMs / 1000}),
            now() + make_interval(secs => ${config.sessionTtlMs / 1000}))`
  ctx.setCookies.push(sessionCookie(config, token, Math.floor(config.sessionTtlMs / 1000)))
}

export function expireCookie(ctx: Ctx): void {
  ctx.setCookies.push(clearSessionCookie(ctx.deps.config))
}
