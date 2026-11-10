# Private indexer recovery evidence

## Scope and outcome

Only `chain-worker/` was modified. No Solidity, shared protocol, public Worker, frontend, AGENTS.md, Git state, accounts, secrets, deployments or remote-chain writes were touched. This is private-service verification, not overall Phase 4 completion.

Final commands, executed from `/home/deseti/projects/retempo`:

| Command | Result | Evidence |
| --- | --- | --- |
| `node node_modules/vitest/vitest.mjs run --config chain-worker/vitest.config.ts --reporter=verbose` | 46 passed, 6 files, exit 0; no unhandled errors | `indexer-recovered-tests.log` |
| `node node_modules/typescript/bin/tsc -p chain-worker --noEmit` | exit 0 | `indexer-recovered-typecheck.log` |
| `node node_modules/oxlint/bin/oxlint chain-worker` | exit 0 | `indexer-recovered-lint.log` |
| `/home/deseti/.local/share/retempo/toolchains/bun-v1.3.14/bun --no-env-file chain-worker/tests/restart-acceptance.ts` | exit 0; actual Wrangler/workerd process restart; identical persisted snapshot | `indexer-recovered-restart.log` |

The test suite uses `@cloudflare/vitest-plugin` with local workerd and real D1 migrations/batches, not an SQL fake. Test D1 is explicitly `CHAIN_DB`, remote bindings disabled. The standalone restart runner creates a fresh scratch persistence directory, applies migrations with explicit `--local`, starts loopback-only Wrangler, stops/restarts it and reads back the same target. Its RPC is explicitly synthetic, not Arc execution evidence. Final run: one indexed event, four durable bindings, one ledger row, zero replay events, paid invoice amount exactly `9007199254740993` after restart.

Configuration inspection: private `wrangler.jsonc` has `workers_dev:false`, `preview_urls:false`, `routes:[]`, one local `CHAIN_DB` and no production IDs. The inspected public root Wrangler configuration has only `DB`, not `CHAIN_DB`. This proves configured binding separation, not an authentication claim against compromised public Worker code. Public service-binding integration remains parent-owned.

## Actual defects and fixes

- Initial requested suite returned 31 passed, one failed and two unhandled rejections. FTP loopback URLs bypassed the URL allowlist; protocol must now be HTTP(S). Existing unsafe-URL test caught this.
- Canonical mismatch called asynchronous `halt()` with bare `return` inside `try/finally`. Lease cleanup could run while the returned rejection remained unobserved. Awaiting halt before cleanup preserves durable fail-stop and removes the unhandled errors. Existing canonical-mismatch tests caught this; the baseline-fixes log records all original 32 tests passing afterward.
- One charge key could be bound to multiple invoice/payment records, allowing the same verified charge to appear paid on multiple logical records. A new real-D1 regression failed with 200 instead of 400. Migration `0002_unique_binding_identity.sql` adds unique `(kind,binding_key)`. One invoice plus one payment remains valid; retries remain idempotent. Existing duplicate databases fail migration rather than silently discarding identity.
- Regex coercion accepted JSON number amounts/charge numbers despite the string-only exact-amount protocol; metadata also accepted strings/arrays. Red tests demonstrated acceptance, then strict type checks rejected these inputs. See identity/wire red logs.
- Added requested private wallet proof endpoint after a red route test. It confirms actual durable wallet actions without fabricating per-organization withdrawal allocation.

## Normalized projection shapes

All `values` are string/boolean/null. Amounts and contract integers are decimal strings; canonical event timestamps are ISO-8601, and hashes/addresses normalize lowercase. Common envelope: `{orgId,kind,recordId,key,state,values,blockNumber,transactionHash}`.

- `plan`: pending/active/inactive; flattened pinned `getPlan`, string amount/interval/trial/grace/vestDuration, boolean active/refund policy, addresses.
- `subscription`: pending/active/canceled; flattened pinned `getSubscription`, decimal chargeCount and accepted terms, ISO/null nextChargeAt.
- `mandate`: missing/active/expired/revoked; decimal caps/spent/nonce, ISO/null expiry; expiry evaluated against indexed block time.
- `invoice`/`payment`: pending/paid; immutable amount/chargeNumber, ISO/null paidAt/periodStart/nextChargeAt, hash/null transactionHash. Paid requires matching independently receipt-verified payment event with exact subscription/plan/customer/merchant/charge/amount, never getter chargeCount alone.
- `escrow`: missing/pending/active/closed/cancelled; flattened pinned `getEscrow`, actual pinned balanceOf/claimableAmount, decimal amounts/durations, ISO/null deadlines, normalized dispute/outcome.
- `dispute`: same escrow identity and values, only when dispute is not none; open/resolved.
- `ledger`: stable event ID recordId; payment/in, claim/in, refund/out or award/in with exact amount, counterparty, createdAt, transactionHash, eventName and raw args. Manager-routed EscrowFunded is not counted again; RefundCredited is sole refund source. Credits are not withdrawals, and payment/claim/award must not be summed together as gross revenue.
- `wallet`: strict private `POST /v1/wallet-snapshot` body `{wallet}`. Empty bindings; only receipt-verified escrow Withdrawn/PayoutAddressUpdated with exact normalized args.account. One projection per event, kind wallet, recordId lowercased wallet, orgId `wallet:${wallet}`, key zero-left-padded bytes32 address, state updated. Values contain raw args plus eventName, original timestamp/createdAt/transactionHash. Envelope retains original blockNumber/transactionHash. No tenant rows, ledger or payout allocations. Multiple proofs share wallet recordId: use returned event identities to distinguish actions.

## Verified boundaries and remaining gaps

Receipt rejection, receipt-log disagreement, foreign/USDC origin, removed/malformed/unknown logs, canonical cursor/log mismatch and persistent fail-stop; atomic lost-lease rejection; concurrent lease exclusion; append-only update/delete/replace guards; bounded scan; duplicate/restart/late-binding replay; exact values above 2^53 and signed 64-bit; wrong-tenant snapshots; chargeCount-without-payment stays pending; pinned state reads and post-read hash mismatch; refund/award nonduplication; wallet account filtering, invalid payloads, canonical halt and full-history cap all pass.

RPC fixtures are synthetic. Parent-owned signed Arc Anvil acceptance, public SIWE wallet ownership, public service-binding integration and browser action confirmation remain separate gates. The private wallet route is not a public authorization mechanism. No standalone invoice contract route is added. Production cron, free-tier CPU/subrequest sizing, pagination beyond the global 5,000-event complete-history cap, dense blocks above 256 logs and an approved reorg-recovery workflow remain documented gaps. No recovery/reset bypass is provided.

Evidence is staged under `chain-worker/evidence/indexer-recovered*` to honor exclusive chain-worker ownership. Parent should copy these files to `docs/phase-4-evidence/indexer-recovered*` when assembling shared evidence; this subagent did not write outside its ownership boundary.
