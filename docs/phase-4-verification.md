# Phase 4 — Local Integration Acceptance Complete

## Result and authority

Phase 4 is complete for the agreed local integration scope: merchant → customer → signed Arc transaction → independently verified backend → persistent dashboard. This is **not** production readiness, a mainnet deployment, or an independent security audit. Phase 5 and Phase 6 require separate approval.

Final acceptance finished at **2026-11-09T17:33:56Z**. Machine-readable authority: [`phase-4-evidence/final-checks.json`](phase-4-evidence/final-checks.json), including command exit codes, durations, log paths and SHA-256 fingerprints for 194 source/migration/contract files. A subsequent reconciliation found no source drift.

## Final execution matrix

All ten commands exited zero. Passing test counts are separate from non-test checks:

- Script/helper/display/read-model/invoice regressions: **32**.
- Public API, auth, financial guards and checkout bridge in real workerd/D1: **90**.
- Private verifier/indexer in real workerd/D1: **46**.
- Wallet SDK, recovery journal and model fixture regressions: **28**.
- Actual frontend SDK against a genuinely signed local Arc node: **1** scenario.
- Actual browser, two Workers, isolated persistent D1 and signed Arc lifecycle: **1** scenario.
- **Total: 198 passing tests/scenarios.** Phase 3's historical contract suite is not added to this count.
- Root/frontend, public Worker and legacy backend TypeScript: pass.
- Private Worker TypeScript: pass.
- Root type-aware lint: pass.
- Production Vite build: pass. Dependency annotation and large-chunk warnings remain; bundle optimization belongs to production readiness.

Reproduce the complete matrix from the repository root:

```sh
python3 scripts/check-phase4-local.py
```

The runner uses the isolated pinned Bun toolchain and Node dependencies already installed for this project. It performs no deployment, account authorization, Git operation or remote chain write. Each Arc node is freshly created, non-forked, loopback-only, funded with artificial balances and stopped after the test. Signing keys stay in memory. Source-to-approved-bytecode Keccak checks reject stale production contract artifacts before deployment into the disposable node.

## Genuine browser and system acceptance

[`signed-worker-integration.json`](phase-4-evidence/signed-worker-integration.json) records **17 signed application transactions**, **27 tenant-filtered canonical events** and eight checked lifecycle stages. Deployment/admin fixture transactions are separate from that application count.

1. Authenticate three independent ephemeral wallets with real SIWE signatures; create merchant catalog/customer/subscription records through the public API.
2. Publish a plan through the actual merchant UI and wallet SDK, after server-derived immutable preparation/binding. Create the private 24-hour checkout capability through the UI.
3. Deny preparation by the wrong customer; preserve identical payment and escrow identities on preparation replay.
4. Use the actual customer checkout and injected EIP-1193 test wallet. Refuse a different genesis despite the same chain ID 5042 before approval; handle wallet rejection without a submission. Then sign the exact USDC approval and one subscription debit.
5. Reload after confirmation but before backend verification. Disable another payment and retry only verification. The private Worker verifies canonical receipts/events; the merchant API overlays paid/succeeded/active state while raw public D1 records remain open/pending/incomplete.
6. Restart both Worker processes against the same isolated D1 state. Sessions, bindings, canonical events and cursor survive; replay creates no duplicate payment.
7. Execute a second subscription, customer dispute, merchant response, arbitrator split, vesting claim and merchant withdrawal. Verify a permissionless withdrawal of existing customer credit to its configured payout and the recipient's exact gas-independent native balance increase. Only the SIWE account owner can read wallet-wide proofs; organization history does not invent an allocation of wallet withdrawals.
8. Create the next subscription invoice through the real merchant UI, preserving its exact UTC period start and immutable price. Finalize it, issue its capability, renew through the customer browser, verify charge number two and its distinct paid invoice/escrow, then claim and withdraw. Final escrow locked and withdrawable liabilities are zero.

The live checkout, wallet-owned portal, merchant overview and merchant escrow controls passed horizontal-overflow checks at **320, 360, 390, 768 and 1440 px**. Actual browser pages raised no JavaScript page exceptions. The renewal payment also passed at 390 px. These checks are not a complete WCAG audit.

## Genuine SDK policy acceptance

[`signed-sdk-integration.json`](phase-4-evidence/signed-sdk-integration.json) records a separate fresh-node scenario with **13 signed transactions**. It executes the production TypeScript SDK rather than a reimplementation:

- Subscribe and grant an explicit finite recurring budget.
- Change dispute windows locally using the configured role.
- Reject stale renewal/mandate terms before another approval or debit.
- Accept the reviewed exact new windows and observe revocation of the old mandate.
- Explicitly create a separate new finite mandate and reduce token allowance to its exact budget.
- Execute a real permissionless recurring charge, account for exact spent budget, revoke, manually renew, and cancel onchain.

## Implemented boundaries

- The private chain Worker owns a separate D1 database and has no public production route, workers.dev URL or preview URL. The public API accesses it through `CHAIN` only; its own guarded database has no financial bypass flag.
- Canonical events are append-only, receipt-checked and deduplicated by chain/transaction/log index. Cursor commit, lease ownership and events are atomic. Canonical/deployment mismatch fails closed; retries and late bindings are replay-safe.
- Exact base-unit strings/BigInt remain on financial paths. Chart coordinates are dimensionless, never used to calculate money. Missing/invalid values are not fabricated zeroes.
- Public capability views do not expose customer contact information or accept guessed invoice UUIDs as payment links. Live/public financial reads have no demo fallback; invented navigation fixture links were removed.
- Pinned contract getters supply escrow balance, frozen and claimable values. The UI does not approximate refund/vesting math.
- Merchant/customer controls include actual plan publication, capabilities, cancellation, escrow claim/refund/dispute/response/resolution/expiration, finite mandates, acceptance and withdrawal/payout actions. Actor permissions and contract simulation remain authoritative.

## Explicit limits and next-phase gates

- Production contracts, Cloudflare resources/bindings, domain/DNS, role custody, transactional email and executor operations are not deployed/configured. No Git add, commit or push was performed.
- Invoice collection is enabled for subscription-backed fixed-price charges. Standalone invoice records do **not** have an enabled onchain checkout; the UI and API fail closed rather than falsely marking them paid.
- Wallet-wide withdrawals are verified for the account owner, not silently allocated into organization payout totals. A complete credit-provenance accounting policy requires an explicit decision.
- Recurring contract authorization and debit were executed locally. No funded production executor, recurring production transaction service or hosted recovery relayer is running.
- The private service deliberately refuses incomplete history beyond its documented MVP safety bound. Dense-block handling, production pagination, scheduling, free-tier CPU/subrequest sizing and approved operational reorg recovery need Phase 5 work.
- The frozen contracts cannot atomically bind every mutable initial-subscribe quote/window term in calldata. SDK rechecks and simulation narrow the race; the residual Phase 3 limitation remains, not a claim of complete race elimination.
- Native issuer blocklisting can stop transactions. The recovery route covers existing credit under the contract's authorization rules; it is not a promise of universal recovery or a mainnet issuer-policy test.

## Evidence and UI regressions

Final logs use `phase-4-evidence/final-*.log`. Private recovery/restart evidence is copied as `indexer-recovered-*`. Screenshots include `signed-plan-publication.png`, `signed-checkout-{desktop,mobile}.png`, `signed-customer-portal.png`, `signed-dashboard-{desktop,mobile}.png`, `signed-merchant-escrow.png` and `signed-renewal-invoice.png`.

See [`phase-4-ui-qa.md`](phase-4-ui-qa.md) for the concrete issues discovered and fixed. Historical failure screenshots/logs are red evidence, not the current acceptance result.
