# Phase 5 — Scoped complete history pagination

## Outcome and verified scope

The global-history availability defect is fixed locally, not deferred as a release gate. Tenant and wallet reads no longer load all canonical events or fail because a global 256-event counter overflowed. `storedEvents()` and its global sentinel are removed. Migration `0004_history_pages.sql` adds indexed in-place event selection and a private operational continuation-token table; it does not grant public D1 financial authority.

Current-source verification:

- **91 private workerd/D1 tests pass**: the 79-case baseline, with obsolete global-cap expectations replaced by isolation expectations, plus 12 history tests. The initial private baseline passed before implementation (`history-private-baseline.log`).
- **124 public workerd/D1 tests pass**: all 121 original cases plus three new continuation-authorization tests.
- **39 SDK/read-model/collector tests pass**: all 29 original cases plus ten pure collector cases.
- Frontend, public Worker, private Worker and SDK TypeScript checks pass. Full existing typed lint (`src scripts worker`) and repository lint pass. An exploratory type-aware run over private code outside the existing typed-lint scope reported pre-existing unsafe-typing diagnostics; the actual project lint commands and private TypeScript checks pass without disabling rules.
- Actual fresh non-forked Arc, two real workerd Workers, genuinely signed lifecycle, restart and paired-D1 cold recovery pass: **13 signed application transactions, 21 canonical events**, authenticated session/cursor preservation and no duplicate replay. `history-system-verified/signed-worker-integration.json` and `history-system-verified.log` contain the actual results. The harness also verifies wallet-owned proofs and exclusion of withdrawals from organization totals.

Authoritative log pointers, exit codes, exact integer fixture total and 25-file SHA-256 source set are in `history-checks.json`. Source-set SHA-256: `d07ff9aab4c0fbac5a2c284257fdb37cd43c2bedc158b9c9f3b19d0600062341`.

## API protocol and paths

Existing `ChainSnapshot` JSON fields remain. Optional `pagination` means the response is **one page**, not all-time history:

```text
pagination: {
  snapshotId: string,
  nextToken: string | null,
  complete: boolean,
  after: number,
  through: number,
  highWater: number
}
```

- Private `POST /v1/snapshot`: `{orgId, pageToken?}`.
- Private `POST /v1/wallet-snapshot`: `{wallet, pageToken?}`.
- New private `POST /v1/customer-snapshot`: `{orgIds, wallets, pageToken?}`. Both lists are derived by the public Worker from authenticated SIWE relationships, never accepted from public request bodies as authority.
- Public `GET /api/orgs/:orgId/chain/snapshot?pageToken=...`: organization RBAC is checked on every request.
- Public `GET /api/wallet/chain/snapshot?wallet=...&pageToken=...`: SIWE wallet ownership is checked on every request.
- New public `GET /api/customer/chain/snapshot/pages?pageToken=...`: re-resolves verified login wallets and matching customer organizations on every request, then issues **one** scoped private page request.
- Legacy public `/api/customer/chain/snapshot` remains for small complete snapshots. It retains its bounded tenant fanout, rejects if any tenant needs another page, and rejects differing tenant cursors rather than presenting partial/mixed totals. Updated frontend callers use `/snapshot/pages` instead.

The actual frontend filename is `src/services/blockchain/arcService.ts`, not `api.ts`. Its organization/customer/wallet methods and `liveBillingService.ts` now use the shared pure `collectChainPages()` helper. The collector retains all results privately until completion, verifies cursor/configuration/bindings/snapshot identity, requires monotonic contiguous keyset progress and a stable finite high-water mark, rejects cycles or missing/inconsistent pagination, deduplicates identical proofs and rejects conflicting ones. It has **no arbitrary page-count cutoff**. It accepts the legacy pagination-absent complete snapshot protocol on the first response. Transport failures, expiry or snapshot changes reject the whole read; no partial totals are returned.

## Bounded work and consistency

- Page size: at most **64 canonical candidate events** before final scope matching, with a 65th-row sentinel per unique selector.
- Selection: at most **32 indexed selector arms**, each using equality prefixes plus `rowid > after AND rowid <= highWater ORDER BY rowid LIMIT 65`. No OFFSET and no full-history JSON parsing. At most 2,080 candidate rows are fetched across the arms; only the selected 64 bodies are parsed. A partial plan index includes only `PlanCreated`/`PlanUpdated`, so reading a plan does not walk all subscription payments sharing that plan.
- Real D1 EXPLAIN tests verify indexed searches and absence of temporary ORDER BY B-trees for the four selection indexes. MAX(rowid) supplies the initial append-only boundary; events remain protected by the existing append-only triggers.
- Opaque UUIDv4 page tokens resolve only against private D1 state. Clients cannot supply offsets, block/status/RPC authority, binding revisions or a chosen high-water mark. Tokens bind scope, immutable relevant binding hash, canonical cursor/hash, initial high-water mark and a **five-minute absolute expiry**. Cross-org/wallet, forged, expired and stale tokens fail. Binding changes and cursor changes require restarting collection. Relevant bindings and runtime state are rechecked before returning a page.
- Page tokens are immutable continuation records. Expired token cleanup deletes at most 64 rows per issuance, through an expiry index; it does not perform an unbounded cleanup sweep or cache terminal financial state.
- Existing 32-binding admission and 26-getter envelope remain. All contract getters are still read at the canonical pinned block with per-request sharing and canonical rechecks, with **40 whole-request RPC maximum** including configuration. There is no terminal-state cache or invented vesting calculation.
- The new customer page scope permits at most 20 related organizations, 32 verified login wallets and **32 combined relevant bindings / the existing getter budget**. Customer binding discovery is one indexed query with a 641-row sentinel over at most 20 admitted tenants; genuine combined-scope overload returns explicit unavailability, not truncated history. These are scope/admission limits, not a history-length limit.
- Dense real-workerd fixture: **1,820 relevant events across 26 plans**, first page returns 64 events using **40 RPC + 8 D1 invocations**. The actual D1 batched queries reported **1,692 rows read** (`history-capacity-metrics.log`). This is a bounded local request measurement, not Cloudflare production CPU telemetry.

Invoice/payment settlement is independent of event-page position: a separate exact composite indexed query selects the canonical `SubscriptionPaymentProcessed` proof by manager/subscription/charge/plan/customer/merchant/amount/name, capped at two rows to detect duplicate proof. A first-page invoice is paid even when its actual proof is on the last page. Non-event getter projections no longer borrow a page-local last-event transaction hash; invoice/payment hashes come from their actual matched proof. Wallet projections carry their canonical event ID for unambiguous deduplication, remain wallet-owned, and are never assigned to organization revenue.

## Regression evidence

New private fixtures demonstrate:

- A small wallet remains readable after more than 256 unrelated canonical events; original stress cases also read empty tenant/wallet scopes beside **5,001 unrelated global rows**.
- **300 relevant wallet events** arrive without duplication in five bounded pages.
- **300 relevant tenant payment events**, alongside 300 unrelated wallet events, produce exactly 300 ledger entries and `2702159776422297900` base units (each amount is above JavaScript's safe integer range). The customer collector also retrieves all 300.
- Charge 300 is already projected as paid on the first 64-event page even though its payment proof is outside that page.
- Plan-only reads do not paginate through 300 unrelated subscription payment events sharing the plan key.
- Late bindings, changed cursors, cross-org/wallet token reuse, random forged tokens and expired tokens are refused.
- Public continuation requests lose access immediately after organization membership or verified wallet ownership is removed.
- Pure collection continues through **301 pages**, rejects no-progress unique tokens, metadata/cursor/binding/event mutations and missing pagination, and deduplicates identical canonical proof repeats.

The initial failing regressions are retained in `history-red.log`, `history-collector-red.log`, `history-customer-red.log`, `history-progress-red.log` and `history-plan-red.log`. Some intermediate logs intentionally contain failures while replacing obsolete expectations and correcting test fixtures to respect real D1 owner/wallet constraints. An initial public baseline command hit its 180-second outer timeout; later complete public runs are preserved, with all original tests passing. The exploratory Bun `test tests/onchain` command was the wrong runner for Vitest: it reported unsupported `vi.stubGlobal` calls and also picked up browser fixtures without their preview. Those results (`history-sdk-baseline.log`) are not acceptance evidence; the explicit Vitest configuration is the authoritative passing SDK/collector run. Final authoritative runs are the log files referenced by `history-checks.json`.

## Remaining production gates

This closes the local global-history DoS/fake-pagination defect; it is **not unrestricted production acceptance**. Continuous cursor changes or token expiry can intentionally abort long collections, requiring an explicit full retry rather than mixed-cursor totals. Existing dense-single-block sync overload, admitted getter/scope ceilings, daily/storage quotas and reviewed operational recovery remain bounded constraints.

Cloudflare Free-plan **10 ms production CPU acceptance remains unproven**. PBKDF2 remains 600,000 iterations; production RPC/deployment identity guards and frozen financial policies are unchanged. Parent-owned final signed browser matrix and independent delta review still follow this work. Deployment/account/custody/code-pin/provider gates remain external. No remote chain writes, account changes, Git operations, Solidity/ABI changes, secrets reads, AGENTS changes, or Phase 4 evidence writes occurred.
