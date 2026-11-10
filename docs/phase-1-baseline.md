# Phase 1 — Local Baseline and MVP Boundaries

## Purpose and release status

This is an evidence-based baseline of the existing Arc Studio export, not a production-readiness certificate or a security audit. **Phase 1 is complete and ready for the user's decision to start Phase 2. Local baseline blockers have been resolved and the relevant checks rerun successfully.** Phase 1 did not migrate the runtime, deploy contracts, publish to GitHub, or broadcast blockchain transactions. Only narrow portability/layout fixes, regression tests, an isolated local test runner, and documentation were added.

The approved destination is Cloudflare Workers/Hono, D1/Drizzle, and Arc mainnet. No testnet deployment is planned. Local tests remain mandatory. Existing subscription and escrow scope is preserved; neither is silently removed to simplify release.

## Reproducible environment

- Source: `/home/deseti/projects/retempo`.
- Bun: 1.3.14, matching `.bun-version`.
- Foundry Forge: 1.7.1, matching `.foundry-version`.
- Solidity compiler: 0.8.28, Cancun target, optimizer enabled, 200 runs, matching `foundry.toml`.
- Dedicated tool binaries: `/home/deseti/.local/share/retempo/toolchains/`.
- Tool downloads were SHA-256 verified against official release metadata/checksums. No shell startup, global Git configuration, or account authentication was changed.
- Dependencies installed from the existing lockfile with `bun install --frozen-lockfile --ignore-scripts`: 845 packages. Lifecycle scripts were intentionally disabled.
- Backend integration tests used a dedicated disposable PostgreSQL 18 container and a new test database. The exported `.env` database was not used or reset. The container and its volumes were removed after testing.
- Generated build outputs and raw baseline logs are kept outside the source tree under `/home/deseti/.hermes/cache/scratch/retempo-phase1/`; selected evidence will be retained under `docs/phase-1-evidence/`.

## Initial execution results (before remediation)

- Dependency installation: PASS with frozen lockfile.
- Production frontend bundle (`vite build`): PASS. Build time reported by Vite: 1m 31s.
- Backend TypeScript (`tsc --noEmit -p backend`): PASS.
- Backend test suite (`bun test backend`): PASS, 99 tests across 7 files, 470 assertions, 0 failures. This includes the 21 unit/mapper tests also executed separately; do not add those 21 again.
- Non-type-aware lint (`oxlint .`, no fixes): PASS.
- Project TypeScript (`bun run typecheck`): FAIL. `scripts/compass-deploy.ts:14` imports undeclared/unresolved `@circlefin/compass-chains`. The `&&` script stops before backend typechecking, so backend was checked separately.
- Type-aware lint (`oxlint --type-aware src scripts`, no fixes): FAIL, 7 diagnostics downstream of that unresolved import.
- Contract build: PASS with Solidity compiler and Forge lint warnings. Warnings include timestamp comparisons and narrowing casts; some warnings belong to test fixtures. These require review, not blanket suppression.
- Contract unit/integration/fuzz subset (excluding `contracts/test/invariant/**`): PASS, 386 passed, 0 failed, 17 Arc-specific tests skipped across 24 suites. These counts were aggregated from Forge's summary rows.
- Full contract suite including invariants: NOT PASSING/INCOMPLETE. The run reached its 600-second timeout (exit 124). Before timeout, Forge emitted an invariant failure event for `invariant_LedgerSumsAndCreditConservation`: `coverage: createAndFund never succeeded in this run`. Historical counterexamples also generated warnings that target selectors had changed. This is a current test-harness/coverage investigation blocker; it is not by itself proof of a fund-loss bug. No full-suite success is claimed, and invariants must be investigated and rerun before mainnet.
- Browser smoke check of the production frontend bundle: landing page and login form render. The landing page has no detected horizontal overflow at 1440x900 or 768x1024, but FAILS at 390x844: document width is 459 px. The developer section extends beyond the viewport (`src/features/landing/Sections.tsx:155–160`). Evidence is recorded in `browser-smoke.json`, `mobile-overflow.json`, and `mobile-developer-overflow.png`.
- No uncaught errors or unhandled promise rejections were captured by the browser smoke hook. This is not a claim that all network requests succeeded: the preview API proxy could not reach port 3001 because no HTTP backend was running during this limited UI check. Authenticated browser workflows were not tested; backend behavior was exercised separately by the 99-test suite. The temporary preview server was stopped.
- Arc-specific behavior: NOT VERIFIED by a plain local Forge run. The Arc USDC tests explicitly skip when the Arc predeploy is absent (`contracts/test/arc/ArcUsdcBase.sol:52–66`).

### Build and export findings

1. `@circlefin/compass-chains` is not declared in `package.json`; the public npm registry lookup returned HTTP 404. The broken import is in an exported deployment helper, not evidence that all UI code fails to bundle. Do not substitute a made-up chain definition or execute this helper. A supported replacement must be selected against official documentation before deployment.
2. The main frontend JavaScript chunk is 2,100,919 bytes (about 2.1 MB uncompressed). Vite reports an oversized-chunk warning. This is a performance concern for later UI work, not a build failure.
3. README and AGENTS phase descriptions are stale: they describe contracts as absent even though substantive manager and escrow implementations and tests exist.
4. Exported deployment helpers include an environment-specific `/home/user/app` path (`scripts/compass-deploy.ts:80`). They are not ready for this machine or production.
5. Historical `cache/test-failures` names are not current results. Only new execution evidence may establish reproducible failures.

## Remediation and verification

### Deployment export portability — resolved

`scripts/compass-deploy.ts` now resolves exact supported EVM identifiers through the already-installed public `@circle-fin/app-kit/chains` export. It retains canonical registry explorer bases and native-gas metadata, rejects unknown/non-EVM identifiers, and derives repository paths from `import.meta.url` instead of `/home/user/app`. No package or lockfile changes were needed.

Regression tests in `scripts/compass-deploy.test.ts` were observed failing before fixes and now pass: **8 passed, 0 failed**. Parent verification reran root/backend TypeScript plus both read-only lint checks successfully. Importing/testing argument parsing does not exercise deployment engines or authorize deployment. Evidence: `remediation/compass-export-remediation.md`, red/green logs, and `remediation/parent-*.log`.

### Mobile developer panel overflow — resolved

The developer section used an implicit grid track whose min-content width was set by the preformatted API example. Explicit Tailwind `grid-cols-1` makes the small-screen track use a zero minimum; the code remains scrollable inside its panel. No content was removed and document overflow was not hidden.

`tests/browser/landing-layout.test.mjs` was run against the actual production bundle. Before the fix, 320/360/390 px checks failed and 768/1440 px checks passed. After the one-line layout fix and a fresh production build, **all 5 viewport checks passed**, preserving the code sample and checking uncaught page errors. Evidence: `remediation/landing-layout-red.log`, `remediation/landing-layout-green.log`, and corresponding screenshots. Browser tooling is isolated under `/home/deseti/.local/share/retempo/browser-test-tools/`; use `RETEMPO_PLAYWRIGHT_MODULE` to select it. This limited public-page regression is not authenticated end-to-end QA.

### Backend regression — reverified

The full legacy backend suite was rerun in a newly created disposable PostgreSQL database: **99 passed, 0 failed**, including migration, auth, tenancy and financial guards. The database container and volumes were removed afterward. No exported `.env` database was touched.

### Invariant replay persistence — resolved and verified

The original failure was reproduced from a historical one-call counterexample under `cache/invariant/failures/`. Compilation `--cache-path` does not isolate invariant replay persistence. A separate `FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR` prevents an old shortened sequence from being mistaken for a fresh 100-call coverage run. A fresh isolated check of the affected ledger invariant passed at **256 runs, depth 100, 25,600 calls, zero reverts**. The original reason the historical counterexample was saved is not established.

Both complete invariant suites finished successfully in a fresh fixed-seed run at the original **256 runs/depth 100**: **19 passed, 0 failed, 0 skipped**, comprising 16 invariants and 3 deterministic handler/seed checks. Each invariant executed 25,600 calls with zero handler reverts. The actual Forge exit code is 0; the recorded run took 863.36 seconds. Shrinking was disabled only to bound failure diagnostics; assertions, coverage requirements, run counts and depth were unchanged. No production Solidity or invariant test source was changed. Evidence: `remediation/invariants-fresh.log`, `remediation/invariant-findings.md`, and reproduction logs.

The supported `bun run contracts:test` command now calls `scripts/check-contracts-local.sh`, which creates a fresh invariant replay directory for every invocation, retains run/depth limits, accepts Forge filters, and propagates the real child exit code. A regression test first failed against the old command, then passed after wiring the script. **2 runner tests passed**, including distinct replay directories and propagation of a deliberately failing fixture process. Fixture tests verify the runner only; they are not counted as Solidity tests.

### Final local acceptance results

- Frozen dependency installation remains valid; dependency versions and `bun.lock` are unchanged. `package.json` changed only the contract-test script.
- Root and backend TypeScript: PASS.
- Type-aware and repository-wide read-only lint: PASS.
- Production frontend build: PASS, with an existing oversized-bundle warning retained as non-blocking performance work.
- Backend: **99 passed, 0 failed** in a disposable database, subsequently removed.
- Offline export-helper regressions: **8 passed, 0 failed**.
- Browser layout regressions: **5 passed, 0 failed** across 320/360/390/768/1440 px.
- Local runner regressions: **2 passed, 0 failed**.
- Solidity across complementary, non-overlapping test-path partitions: **405 passed, 0 failed, 17 skipped**. The non-invariant partition contributes 386 passes and the invariant partition contributes 19 passes. This is aggregate coverage from two successful invocations, not a claim that a single monolithic command was rerun after the timeout.
- The 17 skips are the existing Arc-runtime tests on plain Forge. Arc-native behavior is still an explicit later compatibility/release gate, not silently treated as passed.
- `.env`, the dependency lockfile, production contracts, and invariant test source remain unchanged. No Git repository, remote, login change, deployment, or paid resource was created.

Remaining production blockers below belong to the planned later phases. They do not imply that the application is live or that Phase 2 has begun.

## Feature inventory

### Implemented database/API behavior

- Organizations, memberships, roles, merchant products/plans/customers/subscriptions/invoices/payment records/escrow records/wallet records/API-key records.
- Email/password and EOA SIWE authentication, server-side sessions, CSRF checks, tenant isolation, idempotency, and audit records.
- Integer USDC base-unit accounting and PostgreSQL financial-state guards.

Evidence: `src/services/billing/liveBillingService.ts:14–44`, `backend/src/routes/orgs.ts:64–220`, `backend/src/auth/sessions.ts`, `backend/src/auth/siwe.ts`, `database/migrations/0007_financial_guards.sql`.

A live database record is not an onchain payment. Subscriptions start incomplete; payments remain pending; escrow records are unfunded. Tests passing for those boundaries do not establish settlement functionality.

### Implemented contract source, not application integration

- `RetempoSubscriptionManager`: plans, subscriptions, renewals, recurring charges, capped/expiring/revocable mandates, cancellation, direct or escrow payment routing.
- `RetempoEscrow`: terms acceptance, funding, linear vesting, claim credits, refunds, disputes, arbitration, timeout resolution, bilateral settlement, and withdrawals.

Evidence: `contracts/RetempoSubscriptionManager.sol:240–364,483–523`, `contracts/RetempoEscrow.sol:302–457,489–509`.

### Demo or unavailable behavior

- Analytics, transaction ledger, disputes, and customer checkout/invoice/portal still use demo read models.
- Checkout payment button is disabled (`src/features/customer/CheckoutPage.tsx:97–102`).
- Blockchain service reads USDC balances but hardcodes `not_deployed` and rejects `submitPayment()` (`src/services/blockchain/arcService.ts:24–45`). This hardcoded value is not a network deployment check.
- Verified chain-event processing is a seam, not an implemented indexer (`backend/src/services/chainEvents.ts:3–27`).
- API keys can be issued/revoked but do not authenticate API requests. Webhook delivery and the public Retempo SDK are not implemented.
- Production email delivery is not configured. Development logging is not an email provider.

## Production blockers and migration obligations

1. Resolve deployment-helper dependency/path problems; keep deployment disabled until supported tooling and parameters are verified.
2. Migrate Bun HTTP, SQL, password handling, and PostgreSQL-specific constraints/triggers to Workers/D1 without weakening auth, tenancy, idempotency, atomicity, financial authorization, or integer precision.
3. Replace process-local rate limiting with an appropriate deployment model.
4. Wire wallet transactions to the deployed contracts and map database identifiers and terms to onchain keys.
5. Implement receipt/event verification, checkpointing, deduplication, retries, and recovery. `runAuthoritative()` currently enables a database flag but does not itself verify blockchain evidence; it is not a security proof.
6. Replace demo customer views and metrics with authorized real records or explicitly hide unavailable features.
7. Reconcile escrow semantics: the contract uses linear vesting, credits, and a separate withdrawal; UI copy implying an automatic hold/release is not sufficient. Backend zero-day values also need explicit mapping to contract bounds.
8. Switch the application and SIWE configuration from the current Arc Testnet defaults to verified Arc mainnet settings during the mainnet integration phase.
9. Configure real transactional email if email registration/reset remains enabled. EIP-1271 smart-wallet sign-in is not supported by the existing EOA-only SIWE implementation.
10. Prepare account roles, pause controls, exposure limits, monitoring, recovery procedures, and explicit funded-transaction approval before release.

## MVP acceptance boundaries

These are implementation acceptance targets, not claims of completed features.

### Required core

- Merchant organization, catalog, customers, and invoice management persist correctly with tenant/RBAC isolation.
- A customer can access a real authorized checkout, approve the required USDC allowance, subscribe, inspect the transaction result, renew, and cancel according to contract rules.
- Recurring mandates enforce amount/total/expiry bounds and revocation. If automatic charging is advertised, an actual scheduler/keeper and failure handling must exist; a contract does not execute itself on a timer.
- Escrow payments use accepted terms/arbitrators. Vesting, claims, refunds, withdrawals, disputes, timeout and settlement have truthful UI and an operational path.
- Paid/funded/refunded states arise only from verified chain evidence, never user assertions or demo values. Processing is replay-safe and recoverable.
- Production UI is English, modern dark, keyboard-accessible, and tested at representative mobile/tablet/desktop sizes. Unavailable features must not masquerade as working production functionality.

### Requires an explicit later scope decision

Public API-key authentication, signed/retried webhooks, a published SDK, crosschain bridging, and advanced analytics are not complete today. They must either meet their own acceptance tests or be explicitly deferred/hidden. Their deferral does not silently defer subscription or escrow.

## Account and publication boundaries

- Preserve global/default GitHub account `deseti`.
- Retempo's intended GitHub account is `dewannadrianto`; eventual authentication and commit identity must be project-scoped and verified.
- No `git add`, `git commit`, `git push`, remote changes, Cloudflare login/deployment, or mainnet transactions are authorized merely by Phase 1 execution.
- Existing `.env` values remain confidential and unchanged.
