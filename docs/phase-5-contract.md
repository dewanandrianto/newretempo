# Phase 5 — Production Readiness (Local Complete)

Local acceptance is complete: 342 reported tests/scenarios, current-source matrix and scoped fresh-context review pass. See [verification and remaining production gates](phase-5-verification.md) and [machine receipt](phase-5-evidence/local-readiness.json). This does not authorize Phase 6 or declare unrestricted production readiness.

## Authorization and boundaries

The owner authorized Phase 5 after local Phase 4 acceptance. This authorizes local implementation, hardening, read-only research, isolated load/recovery testing and deployment preparation only. It does not authorize Git staging/commit/push, account changes, paid plans, remote resource creation, DNS changes, contract deployment or funded chain transactions. Phase 6 remains separate.

Preserve subscription billing and escrow, the frozen Phase 3 Solidity/ABI and the financial policies accepted by the owner. Do not reduce password hashing strength or silently change financial/accounting policies to meet a benchmark. Keep secrets out of source/evidence; leave legacy .env and protected AGENTS.md untouched. All project text stays English.

## Acceptance workstreams

1. **Security and release controls:** review public API/session/capability/tenant boundaries, validate production settings fail closed, test HTTP/browser security controls, review dependencies and remediate reproducible in-scope defects without introducing a financial bypass.
2. **Indexer and free-tier capacity:** measure and bound RPC/subrequest/DB/response work, handle dense log ranges safely, preserve atomic cursor/replay/canonical-failure behavior and prove any new pagination or capacity boundary. Do not present a truncated history as total revenue.
3. **Frontend performance:** reduce unnecessary initial JavaScript through actual dependency inspection/code splitting, retain real wallet flows, measure emitted initial assets and exercise browser/regression acceptance after changes.
4. **Operations and deployment preparation:** prepare explicit public/private Worker templates, least-privilege service/database separation, environment/schema validation, backup/restore and incident/reorg procedures. Exercise local recovery and dry-run packaging. No invented account/database/contract IDs or custody approvals.
5. **Final verification and readiness gates:** independent source review, current-source static/test/build/browser/signed-local-chain checks, reproducible evidence and a release checklist that distinguishes completed local readiness work from outstanding owner/external production gates.

## Free-tier verification standard

Use current official Cloudflare limits, not remembered pricing or unlimited-free claims. Local elapsed time is not Cloudflare production CPU billing evidence. State what was measured and keep an explicit launch gate wherever production CPU/subrequest compatibility is not proven. Missing production accounts, deployed code identity, admin custody, email provider, executor funding and independent review must not be filled with test values or declared verified.

## Evidence preservation

Treat docs/phase-4-evidence/final-checks.json as the historical Phase 4 baseline; do not overwrite it with Phase 5 results. New evidence belongs in docs/phase-5-evidence/. Record real exit codes, resource/request counts and source fingerprints. Synthetic fault fixtures are tests, not mainnet observations. Read back actual state after remote writes if separately authorized later; no remote writes are part of this phase.
