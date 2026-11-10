# Workers authentication

`registerAuthRoutes(app)` preserves the legacy `/api/auth/*` response shapes. Global middleware must set `requestId`, `ip`, and `auth` (using `await resolveAuth(c)` from `sessions.ts`) before these routes. Parent HTTP middleware owns origin checks and generic error serialization. `loadWorkerAccount(c, userId)` in `account.ts` returns login wallets and active organization memberships for `/me` and merchant routes.

## Password compatibility and resource limits

Passwords use WebCrypto PBKDF2-HMAC-SHA256 with **600,000 iterations**, a random 128-bit salt, and a 256-bit output. Unknown accounts, wallet-only accounts, and unsupported imported hashes perform the same derivation as a valid-format password check; derived bytes are compared without early exit. The password policy matches the legacy backend.

`auth-passwords.test.ts` exercises this implementation in actual workerd, not Node's crypto implementation. The installed runtime accepts 600,000 iterations. Observed local wall time is approximately 0.6 seconds per derivation; this is **not a CPU quota measurement**. The workerd `node:process.cpuUsage()` probe throws as unsupported. Cloudflare's 10 ms free-tier CPU allowance is therefore **not verified** and remains an explicit deployment blocker pending provider-side CPU metering or an approved architectural decision. Do not lower the iteration count to make a quota pass.

The legacy Bun Argon2 format is deliberately not treated as PBKDF2-compatible. No production users are being imported. Any future imported legacy account requires the normal emailed password-reset flow before password login. Unsupported hashes fail authentication after equalization work.

## Email adapter

There is no public test-token endpoint and no outgoing-link logging. Tests inject a `MAILER` Fetcher that captures JSON bodies locally. A real adapter receives a private POST to `https://mailer.internal/send`:

```json
{"to":"user@example.test","kind":"verify_email","subject":"Verify your RETEMPO email","link":"https://app.example/verify-email#ONE_TIME_TOKEN"}
```

The adapter must return a 2xx response only after accepting delivery. `kind` is `verify_email` or `reset_password`; the latter uses `/reset-password#TOKEN`. Tokens are only in fragments in outgoing links and only HMAC hashes are persisted. Failure or an exception retires the undelivered token without logging provider errors. Registration/resend responses preserve the existing sent booleans; forgot-password always returns the existing generic response.

Absent `MAILER` or `EMAIL_MODE=disabled` fails closed with `email_not_configured`. Production also rejects `EMAIL_MODE=test`; a production binding must use a real delivery adapter and leave this optional mode unset. No email provider is configured by this implementation.

## Database and sessions

All SQL uses D1 bindings and snake_case legacy columns, ISO timestamps, and explicitly generated UUIDs. Session replacement uses `DB.batch` to revoke the prior browser session and insert the fresh session atomically. Secure production cookies always use `__Host-retempo_session`, HttpOnly, Secure, SameSite=Lax, Path=/, and no Domain, even if `COOKIE_SECURE=false` is supplied. Session idle/absolute defaults remain 24/168 hours, with throttled sliding idle updates.

Email account mutations, session revocation, conditional audit insertion, and single-use token consumption run in one serialized D1 batch; a replay cannot mutate the account. SIWE consumes its exact server-issued message hash/address/purpose using one conditional `UPDATE ... RETURNING`, binding link challenges to the session owner. Only EOA signatures are supported, as before.

Rate limits use the shared `rate_limits(key TEXT PRIMARY KEY, count INTEGER, reset_at TEXT)` table and a single atomic upsert, never isolate memory. Expired rows should be deleted by the parent's periodic maintenance job to bound storage. Rows contain account email/IP rate-limit identifiers, never passwords or bearer tokens.
