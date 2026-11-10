# Phase 5 — Private indexer capacity evidence

## Outcome

The original **46** private workerd/D1 tests passed before changes (`indexer-baseline.log`). The current suite passes **79** tests, including **33** new capacity, admission, production identity and scheduled-sync cases. Private TypeScript and lint pass. Machine-readable results and SHA-256 source fingerprints: [`indexer-checks.json`](indexer-checks.json). Historical Phase 4 evidence is untouched.

Fresh, genuinely signed loopback Arc plus two real workerd Workers also pass:

- API lifecycle and paired-D1 cold recovery: `indexer-signed-cold-recovery.log` and `indexer-cold-recovery/signed-worker-integration.json` (13 signed application transactions; 21 canonical events).
- Actual browser lifecycle, renewal, restart and paired-D1 cold recovery: `indexer-signed-browser-recovery.log` and `indexer-browser-recovery/signed-worker-integration.json` (17 signed application transactions; 27 canonical events; nine stages).
- Original restart fixture and new two-restart dense-block refusal/recovery fixture pass independently. These fixtures are synthetic RPC tests, not real-chain observations.

These results are **local correctness/recovery evidence**, not production CPU, mainnet readiness, independent audit or deployment proof.

## Precise wire, configuration and schema changes

No `shared/chain.ts`, ABI, Solidity or financial accounting formula changed. Existing JSON success shapes and endpoint paths remain unchanged. New response headers `x-chain-rpc-calls` and `x-chain-rpc-limit` report the entire private request, including configuration. Capacity failures use the existing HTTP 503 `{error: string}` shape with explicit messages, not truncated success responses.

Production now permits only the officially documented primary `https://rpc.mainnet.arc.io/`, not the stale `https://rpc.arc.network/`. The explorer is `https://explorer.arc.io`, replacing `https://arcscan.app`. Other documented providers were not automatically added to the allowlist. Non-root paths, credentials, query strings, fragments, lookalike hosts and plaintext production URLs remain rejected. Loopback development/test remains supported.

Three production-only required bytes32 identity variables are checked against actual reads before `configured:true`: `ARC_EXPECTED_GENESIS_HASH`, `ARC_EXPECTED_MANAGER_CODE_HASH`, `ARC_EXPECTED_ESCROW_CODE_HASH`. Missing/invalid pins reject before RPC. Mismatched pins reject even when code and reciprocal getters otherwise look valid. Loopback fixtures do not require production pins. Reviewed production values remain an operator/custody gate.

Migration **`0003_binding_capacity.sql`** is required. Its BEFORE INSERT trigger atomically enforces tenant binding/getter admission inside the existing D1 binding batch, including competing requests; rejected admission rolls back the associated key owner. Existing idempotent bindings still succeed at capacity. Oversized pre-migration tenants are not rewritten or silently truncated. Snapshot tests explicitly simulate pre-migration oversized data by removing the admission trigger only in isolated test databases.

The default Worker now has a read-only scheduled sync hook. It is a no-op unless `ARC_SYNC_CRON_ENABLED` equals exactly `true`; checked-in configuration explicitly sets `false` and has no Cron Trigger. Enabled execution uses the same bounded/atomic HTTP verifier, including production identity pins. Failures log only `Retempo scheduled chain sync failed` with a fixed `verification_failed` code. No funded transaction executor, key custody or signing service was added. Do not enable a five-minute trigger before production CPU acceptance and authorization.

## Bounded request envelope and measured fixtures

| Boundary | Implemented behavior |
| --- | --- |
| Whole-request RPC calls | Hard maximum 40, including 10 configuration reads; rejected before issuing call 41 |
| RPC response | Maximum 524,288 streamed bytes before parsing; no dependence on Content-Length |
| Redirects | `manual`; non-OK/redirect responses fail without following another endpoint |
| Outgoing RPC concurrency | Maximum observed 3 (the configuration code-read Promise.all); all subsequent RPC operations sequential with consumed response bodies |
| Scan range | Starts at 32 blocks, halves a complete prefix at most six log-range requests |
| Scan event/log work | At most 16 unique events and 256 returned logs; exact receipt/ABI/canonical verification preserved |
| Impossible single block | Explicit capacity 503; no partial block/event commit and unchanged cursor |
| Existing-event reads | One D1 batch of up to 16 SELECT statements, counted as one invocation |
| Successful nonempty scan D1 work | Six invocations, including operational lease acquisition/release and atomic commit |
| Conservative combined ceiling | 40 RPC + 6 D1 = 46 invocations; no claim these local counters are production billing telemetry |
| Tenant snapshot | At most 32 bindings and 26 distinct pinned getters, fully preflighted before any getters |
| Complete history | Global 256-event safety bound, with a 257-row sentinel; overflow is explicit unavailability, never fake all-time totals |

Assertions use real workerd/D1 and counting RPC fixtures:

- Sixteen events from one transaction: **16 RPC + 6 D1 = 22** invocations, **one receipt**. Receipt fetching was already deduplicated by transaction; this behavior is retained and now tested densely.
- Sixteen sparse event blocks in an initial 32-block range: the planner commits exactly the verified first **eight blocks/eight events using 39 RPC calls**, instead of exhausting a request or skipping events.
- Dense range with an impossible block 2: six range attempts safely commit empty verified block 1; the next request explicitly refuses block 2 and preserves block 1 as the cursor.
- A bad sixteenth receipt commits **zero events**, leaves the cursor unchanged and releases the lease.
- A snapshot of 26 distinct plans uses **40 total RPC calls**. A legacy 27-plan snapshot rejects before getters (11 initial calls), not after returning partial projections.
- Competing new plan admissions with 25 existing plans accept exactly one candidate; 26 existing plans remain readable and idempotent retries succeed.
- One shared plan + one subscription supports **seven escrow bindings** (24 getters); the eighth would require 27 and is denied before acceptance. For event-only payments, two base bindings + 30 payments reach 32; the next is refused. Rejected inserts leave no extra key-owner row.

No persistent or terminal-state getter cache was introduced. Existing per-request pinned getter sharing remains. No contract mutator or financial source was weakened to fit a benchmark.

## Real transport regression found and fixed

Initial fixture tests accepted Fetch `redirect:'error'`, but actual workerd rejects that mode before network access. This caused the parent-reported real signed API config failure. A small fresh-Arc + real-workerd diagnostic reproduced the exact exception (`indexer-real-config-node-red.log`). The fix uses supported `redirect:'manual'` and rejects non-OK responses; no redirect following or guard weakening was introduced. The same real configuration probe now passes (`indexer-real-config-node-green.log`), followed by both signed two-Worker API and actual browser recovery scenarios. The Bun-only configuration probe had passed and was not sufficient runtime evidence.

The first SQL admission trigger also exposed a real D1 compound-SELECT limit during migration. Replacing the seven-arm UNION getter inventory with `json_each(CASE ... json_array(...))` fixed migration execution; all current D1, restart and signed integration tests use the corrected migration.

## Official provenance and production gates

Official references inspected read-only:

- https://developers.cloudflare.com/workers/platform/limits/ — Free 50 subrequests/request, six outgoing connections, 10 ms CPU for HTTP **and cron**, and 100,000 requests/day.
- https://developers.cloudflare.com/d1/platform/limits/ — Free 50 query invocations/Worker request; a `batch()` counts once, not once per contained statement. Daily read/write and storage quotas still need operational sizing.
- https://docs.arc.io/arc/references/rpc-endpoints and https://docs.arc.io/arc/references/connect-to-arc — chain 5042, primary `rpc.mainnet.arc.io`, explorer `explorer.arc.io`. Parent separately verified rendered official details and a read-only actual endpoint response in `official-arc-readonly.json`. Its first urllib-default User-Agent probe returned 403; the explicit honest User-Agent succeeded. That was not a generic network outage. No new server User-Agent claim or production transport proof is inferred from the Python probe.

**Unrestricted production remains gated.** Binding admission preserves the current snapshot getter/binding envelope but cannot reserve unlimited future history: previously accepted subscriptions and direct onchain activity can produce additional events. The global read envelope was intentionally reduced from 5,000 to 256; once crossed, snapshots explicitly become unavailable even for previously accepted records. Complete-history pagination/materialization and an agreed growth/admission policy are therefore required before an unrestricted financial launch. This is not represented as a finished unlimited billing product. Operators must not mistake the current tiny envelope for guaranteed lifetime availability.

Dense single blocks above the bounded verification envelope also require an explicitly reviewed alternative before supporting such traffic; no partial-block cursor protocol was invented. Production CPU for configuration/code hashing, ABI verification, trigger evaluation and snapshot reconstruction remains unmeasured. **Local wall time is not Cloudflare CPU billing.** Actual Free-plan telemetry/CPU acceptance, approved deployment/genesis/code pins, scheduling authorization, daily quotas and operational canonical/reorg recovery remain launch gates. No mainnet transaction, paid plan, remote resource, Git publication or deployment occurred.
