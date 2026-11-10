# Phase 4 Integration Contract — Local Acceptance Complete

Final local acceptance, commands, evidence and explicit production gates: [phase-4-verification.md](phase-4-verification.md). This does not authorize deployment or Phase 5/6 work.

## Approved scope and acceptance

The agreed Phase 4 is end-to-end integration and UI completion, not deployment: merchant → customer → genuinely signed local Arc contract transaction → independently verified backend → persistent dashboard must work. Include exact token approvals, wallet rejection/wrong-network/pending/revert/indexing states, retry/restart/deduplication, responsive dark UI and real public data instead of demos. Subscription **and** escrow remain in scope. No Git publication, account changes, testnet/public-mainnet writes or paid infrastructure are authorized. Phase 5 production readiness and Phase 6 deployment are separate.

Phase 3 source/ABI/build artifacts in `contracts/` are verified. Do not change Solidity to simplify integration. Preserve explicit renewed consent after dispute-window changes and the exclusive arbitration deadline.

## Authority separation

Use a **private chain Worker with its own D1 binding/database** (`chain-worker/`), reachable only through a service binding (`CHAIN`) from the public API. No public routes, workers.dev or preview URLs in its configuration. The public Worker must not have its private D1 binding. Keep Phase 2 financial guards entirely fail-closed; do not introduce a shared authority flag or accept client-supplied paid/funded states.

The private Worker verifies configured chain/address/code/link/token, canonical blocks, receipt success and actual Retempo log origin before storing events/projections. Only Retempo manager/escrow logs drive business state; do not double-count native/ERC-20 USDC Transfer emitters. Persist cursor/hash, deduplicate `(chainId,txHash,logIndex)`, and fail closed on canonical-hash mismatch. Use atomic D1 batches, bounded scan chunks and an operational lease for concurrent retries. Unknown events must never attach to another tenant. Late binding must be replay-safe. All amounts remain decimal base-unit strings/BigInt.

Authoritative chain state lives in the private database; the public API overlays verified projections on its guarded catalog/billing records. Base pending financial records must not be mutated by a general-purpose bypass. PublicAPI authorization and binding ownership are still mandatory; this design does not claim security against arbitrary public-Worker code compromise.

## Shared JSON protocol

Types: `shared/chain.ts`. Do not rename required wire fields without coordinating. Add optional fields if genuinely needed. All bigint-like fields serialize to canonical decimal strings. Private server RPC must not leak credentials; `configuration.rpcUrl` is a safe public endpoint (official Arc or explicit localhost development).

Private Fetcher routes (no public internet exposure):

- `GET /v1/config` → `ChainConfiguration`; unset deployment returns configured=false, no fabricated address.
- `POST /v1/bind` body `ChainBinding` → registered binding. Immutable identity tuple; reject conflicting tenant/wallet/key reuse.
- `POST /v1/sync` body `{}` → `ChainSyncResult`; callers cannot supply logs, statuses, endpoints or deployed addresses.
- `POST /v1/snapshot` body `{ orgId }` → `ChainSnapshot`; only tenant-bound events/projections. Each projection's values are JSON strings/booleans/null. Pinned-block contract getters may establish accurate cumulative state, but payments must have matching verified payment events/receipts, not a client assertion.

Private runtime variables: `APP_ENV`, `ARC_RPC_URL`, `ARC_MANAGER_ADDRESS`, `ARC_ESCROW_ADDRESS`, `ARC_START_BLOCK`; chain fixed to 5042 and USDC fixed to the official six-decimal predeploy. Missing deployment stays disabled. A localhost RPC is allowed only in explicit development/test. Production is not configured by test fixtures.

## Public API contract

Existing `/api/orgs/:orgId/...` CRUD stays compatible. New routes:

- `GET /api/chain/config` → `ChainConfiguration`.
- `POST /api/chain/sync` (authenticated, rate-limited) → `ChainSyncResult`.
- `GET /api/orgs/:orgId/chain/snapshot` (membership/RBAC) → `ChainSnapshot`.
- `POST /api/orgs/:orgId/chain/plans/:planId/prepare` body `{ wallet, payout, arbitrator, customerMayRefundUnvested, graceSeconds? }` → `ChainPlanPreparation`. Actor wallet must be verified for the session; derive references and amounts server-side from tenant records. Register binding **before** wallet submission. No status is published from the HTTP request alone.
- `POST /api/orgs/:orgId/chain/checkouts` body `{ subscriptionId, invoiceId?, expiresInSeconds? }` → `{ token, url, checkout: ChainCheckout }`. Strong, expiring capability; no customer PII in public views. Merchant may create a fresh link after reload; never expose raw capability tokens through public list endpoints.
- `GET /api/public/checkouts/:token` → `ChainCheckout` (real records, no demo fallback).
- `POST /api/public/checkouts/:token/prepare` body `{ wallet }` with verified wallet session → prepared `ChainCheckout` including stable externalRef/subscriptionKey and bound payment/invoice/escrow record IDs. Exact onchain key/actor association, token expiry and record ownership enforced. Retry returns the same logical payment identities.
- `GET /api/public/invoices/:token` → the same safe checkout-backed invoice context, not a guessable private invoice UUID.
- `GET /api/customer/chain/snapshot` → authenticated wallet-owned portal records/events, without arbitrary cross-tenant access. The public API must use verified wallet ownership and private snapshots, not a client-supplied customer ID.

Legacy financial/list reads must expose canonical projected state without accepting forged state writes. Implement live overview/ledger/dispute/portal data from verified records; empty datasets must be honest zero/empty states. Do not erase demo fixtures, but remove them from all live/public paths.

Standalone invoice payment paths need an actual supported contract route. Never pretend a manual invoice is paid or silently route a different amount. Report any such integration gap instead of hiding it; local end-to-end acceptance must cover the publicly enabled route.

## Frontend ownership and behavior

- Wallet integration owns `src/services/blockchain/`, `src/features/onchain/`, `src/features/customer/`, `src/config.ts`, and wallet components. Use verified generated ABI and chain 5042; explicit local configuration must be labeled as simulation. No deployment addresses default to fake/test values.
- Parent owns merchant dashboard/forms, live billing read model/demo removal, responsive shell/styles and the combined browser/worker/Arc Anvil acceptance harness.
- Public API bridge owns `worker/src/chain/`, worker migrations/schema as needed, entrypoint/bindings and existing API projections. Private indexer owns `chain-worker/` and its tests/config only.

The frontend may confirm a receipt, but must show indexing-pending until verified backend projection exists. Retry indexing alone after confirmation; never blindly resubmit payment. Compare exact onchain plan terms before approval/payment. Use exact required approvals, finite explicit mandate budgets, stale-consent protection, and an explicit new mandate after changed acceptance. Preserve rejected/failed/confirmed-but-not-indexed distinctions across retry/reload. Expose real claim/refund/dispute/withdraw/renew/cancel/mandate actions only to the connected permitted actor and state; no fake success toasts.

**Wallet transport safety:** local Arc simulation and mainnet both use chain ID 5042. A chain-ID match alone is insufficient. Before any approval/signing/write, compare the wallet provider's genesis hash and actual manager/escrow bytecode hashes with the configured read RPC. Refuse mismatched RPC worlds or missing proof before opening the wallet. The configured private reader returns `genesisHash`, `managerCodeHash` and `escrowCodeHash` when enabled. Do not let a mainnet-connected wallet send approvals for localhost-only contracts.

## Verification gates

Use fresh localhost-only Arc Anvil with in-memory test keys/fake balances and isolated Wrangler D1 state. Prove actual signed browser/provider requests, receipt verification, persistence after server restart and replay without double billing/ledger entries. Include invalid origin/address/receipt, duplicate sync, wrong tenant, wrong wallet, wrong chain, rejection/revert and disabled deployment tests. Run real workerd/D1 tests, typecheck/lint/build, browser responsive/accessibility/console checks and preserve evidence under `docs/phase-4-evidence/`. Do not declare the phase complete from a subset or a design document.

Protected `AGENTS.md` writes were previously blocked; do not edit it or bypass that denial.
