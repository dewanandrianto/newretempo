import type { Db } from '../db/client'
import { hmacHex, randomToken } from '../security/crypto'

export type EmailTokenPurpose = 'verify_email' | 'reset_password'

const TTL_SECONDS: Record<EmailTokenPurpose, number> = {
  verify_email: 24 * 3600,
  reset_password: 3600,
}

/**
 * Issues a single-use token. Only its keyed hash is stored; the raw value exists
 * only in the outgoing email. Any earlier unused token for the same purpose is voided.
 */
export async function issueEmailToken(
  db: Db,
  secret: string,
  userId: string,
  email: string,
  purpose: EmailTokenPurpose,
): Promise<string> {
  const token = randomToken(32)
  await db`UPDATE email_tokens SET used_at = now() WHERE user_id = ${userId} AND purpose = ${purpose} AND used_at IS NULL`
  await db`
    INSERT INTO email_tokens (user_id, purpose, email, token_hash, expires_at)
    VALUES (${userId}, ${purpose}, ${email}, ${hmacHex(secret, token)}, now() + make_interval(secs => ${TTL_SECONDS[purpose]}))`
  return token
}

/** Atomically consumes a token. Returns null if unknown, expired, or already used. */
export async function consumeEmailToken(
  db: Db,
  secret: string,
  token: string,
  purpose: EmailTokenPurpose,
): Promise<{ userId: string; email: string } | null> {
  if (token.length < 20 || token.length > 200) return null
  const rows = (await db`
    UPDATE email_tokens SET used_at = now()
    WHERE token_hash = ${hmacHex(secret, token)} AND purpose = ${purpose}
      AND used_at IS NULL AND expires_at > now()
    RETURNING user_id, email`) as { user_id: string; email: string }[]
  const row = rows[0]
  return row ? { userId: row.user_id, email: row.email } : null
}
