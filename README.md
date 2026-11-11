# RETEMPO

Subscription billing and escrow infrastructure for SaaS businesses, using USDC on Arc. Originally built with [Arc Studio](https://studio.arc.io).

## Status

**Local delivery Phases 1–3 are complete; production deployment has not happened.** The API runs locally on Cloudflare Workers/Hono and D1/Drizzle. Contract validation reconciles to 470 unique tests passed, including the original-depth invariants, with verified durable ABI/build artifacts and read-only deployment preparation. See [Phase 1 baseline](docs/phase-1-baseline.md), [Phase 2 verification](docs/phase-2-verification.md), [Phase 3 verification](docs/phase-3-verification.md), and [approved contract API policies](docs/phase-3-contract-api.md). This is not an independent audit or approval to deploy.

The Solidity subscription manager and escrow are substantive implementations, but the web application still does not submit payments or process verified settlement events. Payment records remain pending and escrow records remain unfunded. Analytics, disputes, the transaction ledger, and public customer previews still contain labeled demo data. Do not advertise those previews as production settlement.

The approved eventual target is Arc mainnet, without a testnet deployment. Phase 3 verified native Arc behavior locally and on a read-only mainnet fork; no public-chain transaction was broadcast. Existing frontend wallet defaults are not yet switched. Real wallet/consent UX, verified event ingestion, production deployment and funded canaries remain later work requiring the appropriate approval.

## Stack and layout

- `src/`: React 18, TypeScript, Vite, Tailwind, React Router, TanStack Query, Wagmi/Viem/ConnectKit.
- `worker/src/`: Hono API on the Workers runtime. Auth, organizations, roles, catalog, customers, subscriptions, invoices, pending payment/escrow records, wallet associations, API-key records, and audit history.
- `worker/src/db/`: Drizzle D1 schema and connection. Exact money is canonical integer TEXT, handled as BigInt in application code.
- `worker/migrations/`: D1 schema and security triggers, including tenancy, financial guards and append-only audit.
- `worker/tests/`: Vitest tests running on actual local workerd/D1.
- `contracts/`: Solidity/OpenZeppelin manager and escrow, with local unit, fuzz, integration and invariant tests.
- `shared/`: frontend/API types and money helpers.
- `tests/browser/`: browser regression and actual Wrangler-to-frontend acceptance tests.
- `backend/` and `database/`: preserved Bun/PostgreSQL reference implementation and tests; not the default runtime.
- `docs/`: phase reports and retained execution evidence.

## Local development

Use Bun matching `.bun-version`, a supported Node.js runtime for Wrangler/Vitest, and Foundry matching `.foundry-version` for contracts. PostgreSQL and a Cloudflare login are not required for the new local runtime.

```bash
bun install --frozen-lockfile --ignore-scripts
# .dev.vars must contain a locally generated SESSION_SECRET of at least 32 random characters.
# .dev.vars.example documents the key; never use its placeholder as a real secret.
bun run build
bun run db:migrate          # D1 migrations, explicitly local
bun run api                 # Worker + static assets on http://127.0.0.1:8787
# Optional frontend hot reload in another process:
bun run dev                 # Vite proxies /api to the local Worker on port 8787
```

A private local `.dev.vars` was generated during verification. It is ignored by Git and must not be printed, committed, or reused for production. The original `.env` was not modified. `wrangler.jsonc` has no account ID or fabricated production database ID, and its D1 binding is explicitly local. Configure the dedicated Retempo account and real resources only after authorization.

```bash
bun run test                # workerd/D1 tests, no PostgreSQL required
bun run typecheck           # frontend/export scripts, Worker, and legacy reference
bun run lint                # read-only type-aware and repository lint
bun run check               # lint + typecheck
forge build                 # local compilation, not deployment
bun run contracts:test      # local tests with fresh invariant replay persistence
```

`contracts:test` preserves invariant run/depth limits, isolates historical counterexamples, and propagates Forge exit codes. Set `FORGE_BIN` if necessary. `TMPDIR` must point to local scratch; `RETEMPO_CHECK_DIR` optionally selects retained output. Arc-specific tests skip on plain Forge when the USDC predeploy is absent; that is not Arc compatibility verification.

The legacy reference is available through `bun run api:legacy`, `bun run db:legacy:migrate`, and `bun run test:legacy`. Legacy tests require an isolated disposable PostgreSQL `*_test` database. Never reset the database from an existing `.env`.

## Worker configuration and email

- `SESSION_SECRET`: private 32+ character pepper in `.dev.vars` locally and secret storage in production.
- `APP_ENV`: `development`, `test`, or `production`.
- `APP_ORIGINS`: exact permitted origins; production requires HTTPS.
- `SIWE_DOMAIN`, `SIWE_URI`, `SIWE_CHAIN_ID`: exact accepted sign-in identity. Signing a challenge sends no transaction.
- `EMAIL_MODE=disabled`: default locally. The beta uses explicit `EMAIL_MODE=delivery` for Resend.
- `MAILER`: optional Fetcher service binding for the internal email delivery contract. Alternatively, explicit `EMAIL_MODE=delivery` can use `RESEND_API_KEY`, which must be stored as a Worker secret, never as a plaintext config variable.
- Resend sends from `no-reply@auth.retempo.xyz`; verify the sender domain in Resend before enabling delivery. Tests use fake adapters and never contact the provider.
- Session cookie, verification and timeout settings are documented in the Worker source and phase report.

New Worker passwords use Web Crypto PBKDF2-SHA256 with 600,000 iterations. Imported legacy Bun Argon2 hashes are not silently treated as compatible: affected users would require a controlled reset migration. No existing PostgreSQL data was imported or deleted.

## Security and release boundaries

- Preserve global GitHub login `deseti`; Retempo's intended account is `dewannadrianto` with project-scoped authentication and identity.
- No staging, commits, pushes, remote changes, account authorization, paid resources or deployment without the corresponding explicit approval.
- Never expose tokens, private keys, session cookies, `.env`, or `.dev.vars` values.
- D1 financial guards currently deny authoritative paid/funded/settled writes entirely. A reviewed verified-event writer and migration are required before chain settlement can update records; do not add a shared bypass flag.
- API keys are managed records; public API-key authentication, webhook delivery and a published SDK are not implemented or claimed functional.
- Free-tier hosting does not eliminate gas, external service costs, or runtime quotas. Production CPU/traffic limits and password-hashing costs must be measured before release; do not lower password security to satisfy a quota.
