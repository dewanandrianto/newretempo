# Phase 2 — Workers and D1 Local Migration Verification

## Outcome

**Phase 2 is complete locally and ready for the user's decision to begin Phase 3.** This is not a production deployment, mainnet integration, security audit, or claim that payments now settle onchain. No next-phase work is authorized by this report.

The migration initially suffered a model-provider usage-limit interruption. Completion was established afterward by direct parent execution of the combined tests, static checks, actual Wrangler/browser acceptance flow, and persistent database readback—not by treating partial subagent reports as success.

## Delivered architecture

- `worker/src/index.ts`: actual Workers entrypoint, Hono API, real Drizzle/D1 health query, and static-asset fallback outside `/api`.
- `worker/src/auth/`: Workers-native passwords, sessions, SIWE, wallet linking, email tokens, account loading, RBAC, and atomic D1-backed rate limits.
- `worker/src/catalog/`: organizations, membership administration, products, plans, customers, wallet associations, API-key records, and audit history. Real Drizzle queries are used for organization/customer/catalog reads.
- `worker/src/billing/`: subscriptions, invoices, finalize/void, pending payment records, unfunded escrow records, cancellation/edit/discard/history, idempotency and exact amount handling.
- `worker/src/db/`: Drizzle schema and connection with a complete column/representation inventory in its README.
- `worker/migrations/`: schema and security guards for D1.
- `wrangler.jsonc`: explicitly local D1 binding, Worker/static assets, and no account ID or invented production database ID.
- `worker/vitest.config.ts`: current Cloudflare Vitest plugin running tests in actual local workerd with D1 migrations.
- Root scripts now default to the Worker/D1 runtime. `api:legacy`, `db:legacy:migrate`, and `test:legacy` preserve the old implementation as a reference.
- Vite `/api` proxy now targets the local Worker on port 8787.

## Acceptance evidence

### Static checks and build

- Full TypeScript command: PASS for frontend/export scripts, Worker/tests, and preserved legacy backend.
- Type-aware lint and repository lint: PASS, without disabling the existing safety rules.
- Frontend production build: PASS. Existing oversized-JavaScript warnings remain performance work for later UX/release phases.
- Worker bundle dry run: PASS. The command explicitly used `--dry-run`; nothing was uploaded or deployed.
- Local D1 schema and guard migrations: PASS through Wrangler, on a newly created isolated local state directory.

Logs: `docs/phase-2-evidence/typecheck.log`, `lint.log`, `worker-bundle.log`, and `local-migrations.log`.

### Workers/D1 tests

**68 tests passed across 9 files; no failed or skipped tests in that invocation.**

The suite includes actual workerd execution of:

- Schema constraints, Drizzle/D1 representations, exact signed-64-bit-range money stored as TEXT, composite tenant references, unique/index constraints, last-owner protection, and append-only audit.
- Registration, password verification, session rotation, logout, reset/verification single-use and expiry, wallet login/linking, invalid/replayed/parallel SIWE, and shared atomic rate limits.
- Catalog CRUD, tenant and role isolation, API-key secret storage/issuance/revocation, audit rollback, and organization/member protections.
- Billing idempotency, same-key concurrent retries, different-key races, invoice numbering rollback, one live payment/escrow, period uniqueness, transitions, exact amounts above 2^53, audit atomicity, and rejection of forged paid/funded states.
- HTTP CSRF/origin/body limits, structured errors, method/route handling, and the real Worker entrypoint.

Log: `docs/phase-2-evidence/worker-tests.log`.

The new test count is not a claim that the old 99 PostgreSQL tests were copied one-for-one. The new suite targets the different D1 runtime and its concurrency/precision/security behavior.

### Endpoint and schema inventory

The registered HTTP method/path inventory matches the legacy API: **66 legacy routes, 66 Worker routes, no missing or extra entries**. This is an endpoint inventory check, not proof that every conceivable input has identical behavior.

Direct inspection of the actual local D1 schema reports **22 application tables and 260 columns**, excluding Wrangler/internal tables. The original 21 tables are retained, with `rate_limits` added for shared atomic throttling.

Evidence: `route-parity.json`, `schema-inventory.json`, and `worker/src/db/README.md`.

### Actual local browser/API integration

A standalone Playwright test exercised the real Wrangler HTTP server, not a mocked Worker handler:

1. D1-backed health check and denial of anonymous tenant access.
2. Email registration fails closed when no delivery adapter exists.
3. Server-issued SIWE challenge, ephemeral in-memory signature, session creation, and rejection of nonce replay.
4. Persistent organization, product, exact-amount plan, customer, and incomplete subscription creation.
5. Invoice creation, exact total `9007199254740993`, same-key idempotent replay, and finalization.
6. Pending payment and unfunded escrow records with exactly matching amounts.
7. The real authenticated frontend displays the created product after a full reload.
8. Dashboard document fits a 390 px viewport; no uncaught page errors were captured.
9. Logout and rejection of the revoked session.

**One browser acceptance test passed, containing 19 verified steps.** The signing key existed only in memory. No chain transaction, funded wallet operation, blockchain deployment, or testnet/mainnet interaction was performed by this flow.

The Wrangler server was then stopped. Direct D1 readback retrieved the exact created product and invoice with the exact amount still stored as TEXT, proving persistence outside the running server process.

Evidence: `worker-smoke.log`, `worker-smoke.json`, `worker-smoke-desktop.png`, `worker-smoke-mobile.png`, and `persistence-after-server-stop.log`. The reusable test is `tests/browser/worker-smoke.test.mjs`.

## Security and migration decisions

### Exact money and atomic mutations

D1 INTEGER results cross a JavaScript boundary where large values can lose precision. Monetary fields therefore use canonical integer TEXT with range/format constraints; application arithmetic uses BigInt and API values remain decimal strings. No floating-point conversion is used for billing calculations.

Multi-statement mutations and mandatory audit insertions use D1 atomic batches. Conditional writes and uniqueness/constraint checks prevent stale read/check/write decisions from creating duplicate or invalid records. Tests explicitly exercise concurrent retries and rollbacks.

### Financial authority remains fail-closed

The old PostgreSQL transaction-local authority flag was not emulated with a shared mutable D1 flag. D1 guards currently reject authoritative settlement states entirely, including direct SQL and relevant replacement bypasses. A reviewed isolated verified-event writer and migration are required in the later integration phase before real events can update paid/funded/refunded/ledger state.

This preserves the Phase 2 rule: a user or merchant cannot assert that a payment succeeded merely by sending an API field. It does not implement event indexing or settlement early.

### Passwords, sessions, and email

The new runtime uses Web Crypto PBKDF2-SHA256 with **600,000 iterations**, tested in actual workerd, rather than importing Bun's password API. Work factors were not lowered to fit a runtime quota. Legacy Bun Argon2 hashes require a controlled reset/import strategy if real data is migrated later. Existing PostgreSQL data was neither read for migration nor deleted.

Sessions are stored server-side with hashed bearer tokens, secure production cookie behavior, expiry, revocation and rotation. Rate limits live in D1 rather than per-isolate memory. EOA SIWE remains the supported wallet sign-in model; EIP-1271 is not claimed.

Email transport uses a Fetcher service-binding contract. Tests inject a capture adapter; no tokens are returned as a public substitute for email. Local default `EMAIL_MODE=disabled` deliberately returns `503 email_not_configured`. A real provider/service binding and its account configuration remain necessary before public email registration/reset is enabled. Production must not use the test email mode.

## Account, data, and deployment boundaries

- No Cloudflare/GitHub account login or authentication change.
- Global GitHub `deseti` preserved; intended project identity remains `dewannadrianto`.
- No `git add`, commit, push, repository creation or remote changes.
- No remote D1 resource, paid plan, DNS change or production deployment.
- Original `.env` and legacy SQL migrations preserved. A private ignored `.dev.vars` contains a newly generated local-only secret; it was not printed.
- Production contracts were not modified in this phase, and no USDC/gas was spent.
- Temporary acceptance server stopped after verification; test records remain only in the isolated local acceptance database.

## Explicit later-phase work

- Arc mainnet compatibility, network/frontend configuration, contract deployment/verification and approved small-value tests.
- Wallet transaction integration, verified event indexing, replay/recovery, and real financial-state transitions.
- Replacement of remaining demo customer views, disputes and analytics with real supported features.
- Dedicated Retempo account provisioning, real D1 identifiers, production secrets/origins, email provider, DNS/HTTPS, backups and operational recovery.
- Measurement of actual free-tier CPU/traffic/storage limits, including password hashing. Local success is not proof that every production workload fits free quotas.
- API-key request authentication, signed/retried webhooks and published SDK remain unimplemented extras, not secretly claimed working by the existence of their records/tables.

These are not unresolved Phase 2 local-runtime blockers; they are the previously separated contract/integration/release phases.
