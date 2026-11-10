# Production Operations Runbook — Phase 5 Preparation

Status: local preparation in progress. No Cloudflare account, database, DNS, contract deployment, paid plan or production secret has been changed. Account/resource existence, custody and launch approval remain separate Phase 6 gates.

## Configuration and isolation

- `ops/production.template.json` deliberately contains null account/database/deployment identities. Never fill it with example IDs, development contracts or another person's account.
- Run `python3 scripts/production_config.py --input ops/production.template.json` to inspect the fail-closed gate. Exit 2 is expected until all actual owner-supplied identifiers and approved runtime identities exist.
- After authorized resources/deployments exist, keep an owner-local copy below the ignored `.wrangler/production/` namespace. Never put API tokens, wallet keys, seed phrases or secret values in the input JSON.
- The generator checks identifier syntax and configuration structure, not account ownership, resource existence, custody, code review or deployment approval. Its JSON output always keeps `productionResourcesVerified=false` and `deploymentAuthorized=false`.
- For a complete authorized local input: `python3 scripts/production_config.py --input <owner-local-file> --write-dir .wrangler/production/<new-release-directory>`. Output is two mode-0600 JSON files in a new private directory; existing outputs are not overwritten. This command never deploys.
- The public Worker receives only its `DB`, `ASSETS` and `CHAIN` bindings. The private Worker receives only `CHAIN_DB`; it has no public routes, workers.dev or preview URL. Never attach `CHAIN_DB` to the public Worker.
- `SESSION_SECRET` is a required secret name, never a value in `vars`. Actual secret provisioning requires the explicitly approved Retempo Cloudflare account and a user-only credential flow; never reuse inherited personal credentials.
- Production uses HTTPS origins/SIWE metadata, secure cookies, disabled test email, official Arc mainnet metadata and approved genesis/manager/escrow code-hash pins. A hash is not a custody or independent security audit.
- Index synchronization is read-only with respect to the blockchain. A recurring payment executor is a different component with gas/key/exposure requirements; no such production executor or hosted recovery relayer is running.

## Packaging verification

Local packaging uses `wrangler deploy --dry-run` only. This is a compiler/binding-shape check, not a remote deployment, authentication, DNS verification or account-resource test.

`docs/phase-5-evidence/ops-{public,private}-dry-run.log` records actual isolated-HOME packaging with explicit synthetic resource-ID fixtures. The fixtures were temporary and removed. Their IDs are not production defaults. No upload was performed. Use the installed pinned Wrangler rather than accepting an unsolicited update during release preparation.

Before any future real deployment, independently verify the authenticated principal belongs to the dedicated Retempo account, exact resource IDs, exact generated configuration, code identity, billing plan and explicit owner approval. Authorization to log in is not authorization to deploy or spend funds. Git publication remains separately prohibited until approved.

## Backup checkpoint

Do not treat two independently chosen D1 timestamps as an atomic cross-database snapshot.

1. Obtain an approved maintenance window. Stop new application record/binding creation and background index jobs through reviewed operator controls; do not invent an undocumented maintenance toggle.
2. Preserve existing transaction journals and capture pending transaction hashes. Never invite users to repay merely because indexing is delayed.
3. Record both actual database identities, Worker versions, migration versions, exact private canonical cursor/hash, approved contract identity and the maintenance interval. Keep customer/contact data and secrets out of public logs.
4. Capture a backup/checkpoint for both databases while writers are stopped. Retain the immutable binding/reference identities: losing their UUID associations cannot be repaired by inventing a new invoice and claiming the old chain payment belongs to it.
5. Confirm the checkpoint is readable before resuming writes. Record who approved the operation and where the private backup is retained.

Cloudflare D1 currently documents **7 days of Time Travel on Free** and 30 days on Paid; the generic Time Travel introduction discusses 30 days, so do not assume the paid retention on a free account. Official references:

- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/reference/time-travel/

Actual remote Time Travel/export/restore has not been exercised in Phase 5 because no Retempo Cloudflare resources or account operation is authorized. Local cold-copy recovery is a separate test, not a substitute claim about Cloudflare recovery guarantees.

## Restore and canonical mismatch

- Preserve the failed deployment, raw error classification and original databases as evidence. Never delete/rewrite append-only canonical events or clear a halted flag in place to force a green health check.
- Restore into an isolated reviewed target; do not overwrite the only surviving state. Keep public/private checkpoints and binding identities aligned.
- Verify schema, exact TEXT amounts, tenant ownership, sessions, bindings and canonical cursor/hash. Reconcile against read-only chain state and successful matching receipts. Never use public paid/funded writes or client transaction claims as a recovery shortcut.
- If chain/deployment identity or canonical hash differs, remain halted. Investigate the RPC provider and deployment first; retain the old evidence. Any rebuild/re-index strategy requires an explicit operator review and approved source checkpoint. Do not silently discard or remap funds/history.
- Replaying must not create another debit or another logical payment. Restore verification should use the original transaction/event identities and source records.
- Resume only after the restored application and private authority agree and the operator approves. If a payment's public identity cannot be recovered, expose an honest reconciliation issue rather than fake paid status.

## Incident triage

- **RPC outage/rate limit:** preserve the cursor, use bounded retries and show indexing pending/unavailable. Do not resubmit a confirmed payment.
- **Wrong genesis/code/canonical block:** fail closed and preserve evidence; no automatic chain reset.
- **Capacity reached:** stop admitting unsupported new bindings before wallet submission where possible; retain readable accepted history. Never silently truncate totals. Report the actual supported envelope and escalate rather than turn on paid infrastructure.
- **Issuer blocklist:** do not promise claims/refunds can bypass issuer policy. Existing withdrawable credit may use the frozen contract's permitted payout/signature/clean-relayer paths; no hosted relayer is provided.
- **Protocol emergency:** only an explicitly authorized role/custody operator may submit a pause or other funded action. Review the frozen contract's exact pause/withdrawal semantics and financial policy first. This runbook is not transaction authorization.
- **Account password recovery:** the approved reset policy atomically revokes every login-wallet binding and session, consumes the reset token and invalidates pending wallet-link challenges. Login bindings remain tombstoned/reserved rather than reassigned to a new account. Financial wallet records, escrow balances and payout addresses are not changed. The recovered user signs in with the new password and uses a fresh wallet signature to reactivate their own login binding. A revoked wallet cannot silently create a second account or regain access through an in-flight pre-reset sign-in.
- **Credential exposure:** revoke/rotate through the owner's approved account workflow, invalidate affected sessions as supported and preserve audit evidence. Never paste replacement secrets into chat or public config.

## Release gates still requiring real-world evidence

Dedicated account identity/resources, production CPU/free-tier profiling, domain/HTTPS ownership, actual deployed code/custody roles, secret provisioning, real email delivery if enabled, alert destinations, funded executor policy if wanted, a small-value mainnet canary with exact approved costs/recipients, and an independent review/audit appropriate to financial exposure. No gate is satisfied merely by a syntactically valid config, a local elapsed-time benchmark or a successful dry-run.
