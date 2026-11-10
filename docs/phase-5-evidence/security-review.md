# Public Worker security review and local cost evidence

Recorded 2026-11-10. This is an implementation self-review with reproducible local workerd/D1 tests, not an independent audit, production CPU certification, deployment authorization, or overall Phase 5 completion. The parent workstream owns independent final review and operations templates.

## Verified result

- All **121 public tests passed**: the original 90 plus 31 new cases. No tests were removed. The existing production-onboarding fixture now supplies a fresh ephemeral shape-valid secret and production-shaped origin; its unverified-email rejection assertion remains unchanged.
- Root/frontend, public Worker and preserved legacy backend TypeScript passed through the root `typecheck` command. Root type-aware lint passed.
- Exact commands, exit codes, elapsed durations, raw samples, and 63 source/test/migration/config fingerprints are in [`security-results.json`](security-results.json). Final logs: [`security-public-green.log`](security-public-green.log), [`security-typecheck.log`](security-typecheck.log), [`security-lint.log`](security-lint.log).
- No Git operation, account change, deployment, paid resource, remote chain write, Solidity/ABI edit, or Phase 4 evidence overwrite was performed. Local synthetic service fixtures are explicitly labeled; they are not a replacement for the private verifier's separate acceptance tests.

## Reproduced findings and bounded fixes

| Finding | Reproduction before fix | Change |
| --- | --- | --- |
| Production settings accepted the exported local secret, credential/path-bearing or loopback origins, mismatched SIWE domain/URI, non-Arc or unsafe-number chains, unknown/implicit email modes and unbounded/invalid session durations. | `security-config-red.log`: 19 unsafe cases returned 200 instead of 503. `security-secret-red.log`: a repeated patterned hexadecimal fixture was also accepted. | `worker/src/config.ts` exports the public runtime `validateBindings`; `http.ts` invokes it before CSRF, auth or route DB work. Misconfiguration returns a generic 503 `configuration_error`, never the offending value. Local development/test compatibility is retained. |
| Production API-key creation issued `rtk_test_` records even though API-key authentication is deliberately unimplemented. | `security-api-keys-red.log`: actual signed SIWE session, organization creation, then key creation returned 201. | Production creation now returns explicit 503 `api_key_auth_unavailable` before generating/storing a token. Existing local records-only behavior and key listing/revocation are retained. This does not claim a previously absent API-key auth feature now exists. |
| The JSON media-type check accepted `application/jsonp` via a substring match. | `security-http-red.log`: nonce request returned 200 instead of 415. | Exact case-insensitive `application/json` media type is required, with normal semicolon parameters accepted. |
| Production API success/error responses omitted HSTS. | `security-http-red.log`: HSTS was null. | Production API responses include `Strict-Transport-Security: max-age=31536000`, without imposing a subdomain policy. Static-asset/edge headers remain the operations workstream's responsibility. |
| Customer portal snapshot fanout grew with every merchant association. | `security-fanout-red.log`: a real D1 fixture with 21 tenant relationships returned 200, making one service request per tenant plus configuration. | Query detects the 21st tenant and fails with 503 `customer_snapshot_capacity` before any private service call. At 20 tenants the fixture verifies exactly 21 direct service calls. No financial history is silently truncated. This is an explicit MVP ceiling, not proof that all descendant work fits production quotas. |
| Disabled chain metadata used obsolete/nonofficial endpoints. | `security-metadata-red.log`: public metadata returned `rpc.arc.network` and `arcscan.app`. | Disabled metadata now advertises `https://rpc.mainnet.arc.io`, `https://explorer.arc.io`, chain 5042, while remaining disabled with null deployment addresses. Official rendered Arc metadata/read-only reachability evidence belongs to the parent workstream; no new mainnet reachability claim is based on this unit regression. |

All listed red runs exited 1 for the stated assertion failure. Green runs are retained separately. `security-public-first.log` records an intermediate fixture failure, not final acceptance.

## Boundary review

- **Session/auth:** opaque cryptographically random session tokens; HMAC hashes at rest; rotation, explicit logout/reset revocation, absolute and idle expiry, active-user checks. The full production middleware test genuinely signs SIWE, receives a host-only `__Host-`/HttpOnly/Secure/SameSite=Lax cookie, verifies a session, rejects nonce replay, rejects cross-origin logout without revoking the session, then proves logout revocation. Test credentials are ephemeral and are not logged.
- **Password/email:** PBKDF2-SHA256 remains **600,000 iterations** with a random 16-byte salt. Correct, incorrect and unsupported-account verification retain expensive work. Password policy, single-use email/reset token transactions, delivery failure invalidation and reset session revocation remain covered. Production test-email mode is rejected. A MAILER binding alone does not certify that the provider is trustworthy or working.
- **SIWE:** server-issued bounded challenges bind address, exact configured domain/URI/chain, message hash, purpose, expiry and linking owner; EOA recovery is checked and nonce consumption uses atomic D1 `UPDATE ... RETURNING`. Contract-wallet/EIP-1271 support remains explicitly unavailable. Public-client transaction hashes cannot supply sign-in or payment authority.
- **Tenant/RBAC:** membership is resolved against active organizations; resource queries include tenant IDs; role rank checks and last-owner DB protections remain in place. Wallet-wide proof reads require the session owner's verified SIWE address. Customer capability preparation additionally checks the customer wallet and server-owned immutable identities. Existing cross-tenant, wrong-wallet, role and private-projection mismatch regressions pass.
- **Capabilities:** checkout capability tokens are 32 random bytes and only SHA-256 hashes are stored; they expire and public views omit customer contact information. Read responses are no-store/no-referrer. Preparation is authenticated; possession alone cannot settle a payment. Capability revocation/rotation beyond expiry is not newly implemented.
- **Financial authority/idempotency:** client-supplied `txHash`, amount, status and contract fields cannot settle records. Existing tests send these fields and verify amounts are server-derived and records stay pending/pending_funding. Sync rejects caller-supplied logs/endpoints. Public D1 financial guards and the isolated private event writer remain unchanged. Scoped request hashes, immutable identities, same-key/different-body conflicts and concurrent replay tests pass. No financial bypass was introduced.
- **HTTP:** actual streamed JSON bytes remain capped at 256 KiB even without Content-Length; Zod bounds auth strings and collection page sizes. Unsafe methods require an allowed Origin and the exact custom CSRF header. No CORS allow-origin/credentials headers are emitted: browser support remains same-origin, not a new cross-origin API promise. Error responses retain no-store, nosniff, no-referrer, restrictive API CSP and a request ID. Safe internal error logs intentionally appear in fault-injection tests; no SQL, bound credentials or provider error bodies are logged.
- **Rate limiting:** auth limits use atomic D1 upserts rather than isolate-memory counters. The bounded concurrent invalid-password fixture verifies the actual persisted count. IP trust assumes Cloudflare overwrites `CF-Connecting-IP`; a local caller can set it, which is not edge spoofing evidence. Application rate limits do not protect the overall account request quota or replace deployment abuse controls.

## Exact production environment contract

The runtime guard is exported from `worker/src/config.ts` for public API validation; operations schema/generator code should mirror this contract, not overwrite this module with test settings.

| Setting | Production requirement |
| --- | --- |
| `APP_ENV` | Exact `production`. Development/test must never be used in a deployed production template. |
| `SESSION_SECRET` | A privately generated **32-random-byte secret encoded as 64 lowercase hexadecimal characters**. The guard rejects fewer than eight distinct characters and repeated shorter patterns in addition to the exact shape, eliminating shipped local/test phrases and obvious fixtures. Shape checks cannot certify entropy, custody or rotation. Never deploy a public test fixture. Rotation invalidates existing HMAC-backed sessions/tokens. |
| `APP_ORIGINS` | Nonempty comma-separated canonical HTTPS origins, no empty entries, credentials, paths, queries or fragments. Surrounding entry whitespace is trimmed. No localhost, IP literal, `.localhost`, `.local`, `.test` or `.invalid` host. Each entry must equal its parsed canonical origin. |
| `SIWE_DOMAIN` | Exact host, including a nondefault port if present, of `SIWE_URI`. |
| `SIWE_URI` | HTTPS URL on one of `APP_ORIGINS`, with a production-shaped hostname and no credentials, query or fragment. An application path is permitted. |
| `SIWE_CHAIN_ID` | Exact string `5042`. |
| `EMAIL_MODE` | Explicit `disabled` or new explicit `delivery`. `test`, missing and unknown values fail closed. `disabled` leaves email-dependent registration/recovery unavailable while preserving SIWE and existing password login. `delivery` requires the `MAILER` service binding. Actual delivery still needs provider configuration/approval and acceptance evidence. |
| `COOKIE_SECURE` | Omitted or exact `true`; production always emits Secure host-only cookies. False/misspelled settings are configuration errors. |
| `REQUIRE_VERIFIED_EMAIL` | Omitted (production default true) or exact `true`; false/misspelled settings fail closed. This is the existing organization-onboarding email policy, not a claim that all authenticated reads require email. Wallet-only users remain supported. |
| `SESSION_TTL_HOURS` | Omitted for 168 hours, or a numeric decimal string from 1 through 168. |
| `SESSION_IDLE_HOURS` | Omitted for 24 hours, or a numeric decimal string from 1 through 24; effective configured idle duration must not exceed the absolute duration. |
| `DB`, `CHAIN`, `ASSETS` | Actual deployment bindings remain separate operations gates. Public and private D1 must remain isolated; no invented deployment IDs are supplied here. |

## KDF/SIWE capacity evidence and launch gate

Current official Cloudflare documentation retrieved during this review:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): Free **10 ms CPU/request**, **50 subrequests/request**, **100,000 requests/day**. CPU is not elapsed I/O wait time. Limits page reported updated 2026-10-29.
- [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/): native Web Crypto supports PBKDF2 and is preferable to pure-JavaScript cryptography for supported operations. Support is **not** a 10 ms CPU guarantee. Page reported updated 2026-09-30.
- [CPU profiling](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/) and [metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/): local profiling can identify hot code; actual deployment CPU/usage and exceeded-resource outcomes must be checked separately. Worker timers are security-constrained and do not substitute for provider CPU accounting.

Reproduce all public tests and bounded cost samples:

```sh
node node_modules/vitest/vitest.mjs run --config worker/vitest.config.ts --disableConsoleIntercept
```

For the limited benchmark alone:

```sh
node node_modules/vitest/vitest.mjs run --config worker/vitest.config.ts worker/tests/security-cost.test.ts --reporter=verbose --silent=false --disableConsoleIntercept
```

The final full-suite run reports the following **local elapsed wall times only**, with raw samples and aggregation in `security-results.json`:

| Operation | Samples | Minimum / median / maximum elapsed ms |
| --- | ---: | --- |
| Native PBKDF2 hash, 600,000 iterations | 3 | 551 / 556 / 567 |
| Correct password verification | 3 | 553 / 554 / 558 |
| Incorrect password verification | 3 | 553 / 557 / 559 |
| EOA SIWE message recovery only | 6 | 4 / 4 / 8 |
| Complete SIWE verification HTTP + D1 + session | 6 | 45 / 46.5 / 57 |

The benchmark also verifies six replay denials and six logout revocations. A ten-concurrent-request invalid-password burst produces exactly eight 401 responses and two 429 responses; the D1 email bucket persists count 10. Eight requests may still perform the full expensive KDF. Observed elapsed range was 100–5256 ms, not CPU billing time. No external fetch or remote write is involved. Results vary with host contention and timer quantization; the dedicated benchmark log is another actual run, not an identical performance promise.

**OPEN LAUNCH GATE:** No production CPU counters are available here. The password path cannot be certified to fit Workers Free, and SIWE recovery alone is not the whole HTTP/auth/DB path. Before exposing production authentication, authorized deployment/provider measurements must verify cold/warm and bounded-concurrency CPU, subrequest totals including descendant services, failure paths, exceeded-resource outcomes and daily traffic/storage budgets. Password registration, login (including missing account/wrong password), reset and SIWE verification all need evidence. Do not reduce PBKDF2, disable password auth silently, assume native cryptography is CPU-free, or authorize a paid plan as a workaround. An incompatible result requires an explicit owner-approved architecture decision.

Remaining external/operational gates also include real MAILER delivery/custody if email is enabled, secret custody/rotation, production deployment/chain addresses and roles, account-level abuse controls, retention/cleanup of expired sessions/nonces/token/rate-limit rows, actual multi-tenant response/DB sizing, operations recovery and the independent final review. The 20-tenant ceiling prevents an unbounded public loop but does not close these gates. No new broad Arc RPC-connectivity blocker is asserted; the parent has separate successful official-endpoint read-only evidence.
