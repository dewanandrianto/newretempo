# Legacy Backend API Reference

The default runtime has moved to `worker/` (Workers/Hono and D1/Drizzle). This directory is preserved for reference and legacy regression tests; its historical phase labels do not describe the current delivery status. Use `bun run api:legacy`, `bun run db:legacy:migrate`, and `bun run test:legacy` for this implementation. The default `api`, `db:migrate`, and `test` commands now target the Worker. Never use an existing `.env` database for destructive tests.

Bun + TypeScript HTTP API for RETEMPO, backed by PostgreSQL. Start this reference with `bun run api:legacy` on its configured port (3001 by default). The current Vite proxy targets the new Worker on port 8787, not this legacy server.

```
backend/src
  config.ts        environment parsing and production safety checks
  db/              Bun SQL client, transaction helper, migration runner
  http/            router, CSRF/origin checks, cookies, rate limiter, guards (auth + org access)
  auth/            Argon2id passwords, sessions, email tokens, mailer, SIWE, permissions
  services/        one module per resource; every query is scoped by org_id
  routes/          HTTP wiring for auth and organization-scoped resources
backend/tests      unit + integration tests (need TEST_DATABASE_URL)
```

## Authentication

- **Email + password.** Argon2id (19 MiB, 2 passes). Passwords are never stored or logged.
  Unknown emails take the same time and return the same error as wrong passwords.
- **Sessions.** Random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` and `__Host-`
  prefixed in production). Only an HMAC of the token is stored. A new session is issued on every
  login / registration / wallet sign-in and the previous one is revoked (no fixation). Logout and
  password reset revoke server-side. Absolute lifetime 7 days, sliding idle timeout 24 hours.
- **Email verification and password reset.** Single-use tokens, hashed at rest, 24 h / 1 h expiry,
  delivered in the URL fragment. Development links are printed to the server console only when
  `EMAIL_MODE=log` and `NODE_ENV` is not `production`. With no provider configured, registration and
  reset requests fail with `503 email_not_configured` instead of pretending to send.
- **Wallet (SIWE, EIP-4361).** `POST /api/auth/siwe/nonce` returns a server-built message with a random
  single-use nonce (5 minute expiry). `POST /api/auth/siwe/verify` checks: signature recovers to the
  message address, message equals the one issued, domain, URI and chain ID match server config,
  issued-at / expiration are valid against the server clock, nonce is consumed atomically (replay
  fails). A bare address never authenticates.
  **Only EOA (ECDSA, 65-byte) signatures are supported. EIP-1271 contract-wallet verification is NOT supported in Phase 2**; such signatures are rejected with an explicit error.
- **CSRF.** State-changing requests need an allowed `Origin` and the header `X-Requested-With: retempo`, on top of `SameSite=Lax`.
- **Rate limits** (in memory, single instance): registration, login (per IP and per email), password reset, verification, SIWE.

## Authorization and tenancy

Every merchant route is `/api/orgs/:orgId/...`. `requireOrg()` looks up the caller's membership for that
org id and returns 404 for non-members, so ids belonging to other tenants are indistinguishable from missing ones.
Services only use the org id returned by that check. Roles:

| Capability | member | admin | owner |
| --- | --- | --- | --- |
| Read everything in the org | yes | yes | yes |
| Customers and invoices (create / edit drafts / void) | yes | yes | yes |
| Products, plans, subscriptions, payment and escrow records, wallets, API keys, org profile, team | no | yes | yes |

Admins cannot change or remove owners or grant admin; the last owner cannot be removed.

## Money

Amounts are integer USDC base units (6 decimals) in `BIGINT` columns, `bigint` in code, decimal-integer
strings in JSON. Nothing uses floats. Create requests for invoices, payments and escrows require an
`Idempotency-Key` header; replays return the original record (200), key reuse with a different body is 409.

## Escrow and payments in Phase 2

You can create, read and discard unfunded escrow records, and create/cancel pending payment records.
There is no endpoint, and the database does not allow, marking an escrow funded / released / refunded /
settled, a payment succeeded, or an invoice paid. Those transitions are reserved for verified chain events.

## Scripts

`bun run api:legacy`, `bun run db:legacy:migrate`, `bun run test:legacy`. The shared `bun run check` command checks both current and legacy TypeScript.

## Known limitations

Rate limiting is per process. No email provider adapter exists. API keys are issued and stored hashed but do
not authenticate requests yet. Webhook tables exist without endpoints. Transactions and disputes have schema but no API.
