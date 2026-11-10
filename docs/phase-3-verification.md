# Phase 3 — Contract Validation and Read-Only Mainnet Preparation

## Outcome

**COMPLETE: local contract validation and deployment preparation.** All acceptance checks below have actual execution evidence. This is not a production deployment, application payment integration, independent audit or permission to broadcast. The next delivery phase requires the owner's approval.

The final machine-readable result is `docs/phase-3-evidence/summary.json`.

## Approved contract changes

The owner selected and the implementation now enforces:

1. **Renewed customer consent before billing under changed escrow dispute windows.** Initial escrow subscriptions record the execution-time windows. Both manual and recurring payments reject changed windows before any debit or accounting mutation. Only the customer of an active escrow subscription can accept exact expected current windows; stale acceptance fails. Changed acceptance revokes an active mandate, and recurring billing needs a separately authorized new mandate. Repeating unchanged acceptance does not reset budget/spend/generation.
2. **Exclusive arbitration deadline.** Arbitration is allowed strictly before the snapshotted resolution deadline. At/after it, `ResolutionWindowEnded()` rejects the ruling without changing funds; permissionless expiration applies the deterministic split. Deadline passage still requires a transaction to execute expiration.

ABI, event/error/reason changes, initial-quote limitations and frontend requirements are documented in `docs/phase-3-contract-api.md`. The two policy findings and their executable reproductions/remediation are recorded in `docs/phase-3-security-review.md`.

## Complete test reconciliation

**470 unique contract tests passed; 0 failed; 0 skipped**, verified against the exact current `arc-forge test --list --json` inventory rather than inferred from partial totals.

The three non-overlapping native Arc partitions were:

- Functional/unit/integration/fuzz/preparation/consent: **451 passed** across 27 suites.
- Escrow invariant fixture: **9 passed**, including 8 stateful invariant checks and its smoke test.
- Manager invariant fixture: **10 passed**, including 8 stateful invariant checks and two fixture/smoke checks.

All **16 stateful invariants** retained **256 runs × depth 100**: 25,600 calls each, **409,600 total handler calls**, with zero handler reverts. Assertions, weighted selectors, negative arguments and per-action coverage guards were retained. This is not a claim that expected negative protocol calls inside the handlers never reverted.

Native Arc rejects impossible transaction senders before EVM execution. Excluding zero alone was insufficient. The handler dispatcher is now a valid fixed EOA; handlers still select/prank the full protocol actor set themselves. Their only outer-sender authorization is the setup-only reset helper, which is not a fuzzed selector. No production caller authorization was weakened to green the suite.

Evidence: `test-inventory.json`, `test-reconciliation.json`, `functional-approved.log`, `escrow-invariants-approved.log`, `manager-invariants-approved.log`, and their actual exit-code records.

## Artifact provenance and durable deliverables

Solc **0.8.28+commit.7893614a**, Cancun, optimizer enabled with **200 runs** were verified from compiler metadata. Both runtime templates fit the EIP-170 limit: escrow **20,900 bytes**, manager **16,542 bytes**.

Every compiled dependency in the actual escrow invariant artifact (59 sources), manager invariant artifact (61), escrow artifact (33) and manager artifact (22) was hashed against current source. The escrow partition's broad run snapshot included an intermediate manager hash, but that manager is not in the escrow fixture's compilation graph; the entire actual graph, including the exact escrow/harness, matches. Relevant source checks were not replaced with an unqualified whole-workspace assumption.

Durable, verified artifacts and ABI are retained outside prunable scratch:

- `contracts/contract-metadata/phase-3-build/RetempoEscrow.sol/RetempoEscrow.json`
- `contracts/contract-metadata/phase-3-build/RetempoSubscriptionManager.sol/RetempoSubscriptionManager.json`
- `contracts/contract-metadata/phase-3-build/manifest.json`
- `contracts/abi/RetempoEscrow.json`
- `contracts/abi/RetempoSubscriptionManager.json`

Strict JSON parsing passed. The manifest explicitly marks these as local release candidates, with no deployed addresses or broadcast. Evidence: `artifact-attestation.json`, including full compiler-source hash maps.

## Actual Arc execution and mainnet read-only compatibility

- Official isolated Arc Foundry **v0.8.0-4** binaries were downloaded from Circle's official release. SHA-256 matched release metadata and the checksum asset. No Sigstore attestation or independent tool audit is claimed.
- Official mainnet RPC readback confirmed chain **5042**, USDC code and **6 ERC-20 decimals** at `0x3600000000000000000000000000000000000000`.
- All **17 native Arc USDC cases passed again against final source on a local mainnet fork pinned to block 30197082**. These are an additional execution context, not 17 additional unique tests in the 470 total.
- The genuine signed localhost Arc Anvil acceptance test passed with **20 recorded successful steps**: linked paused deployment, role-controlled startup, real local predeploy approval/subscription/funding, exact liabilities, claim, withdrawal, actual native-gas-adjusted beneficiary balance, issuer blocklist admission and clean-relayer recovery of existing credit.
- The signed-node test verifies compiled production-source Keccak hashes before using the durable artifacts. Test keys stay in memory, fake balances are set only on the fresh loopback node, and the owned child node was stopped in `finally`.

A genuinely signed zero-value transaction from the tested blocklisted EOA was rejected before EVM execution, with unchanged nonce/balance. A clean relayer successfully updated its payout by beneficiary signature and withdrew already-created credit. This does not promise that a blocked EOA can directly create new claims/refunds, nor override mainnet issuer policy.

Evidence: `mainnet-readonly-probe.json`, `mainnet-fork-approved.log`, `mainnet-fork-approved-result.json`, `arc-anvil-smoke-final.log`, `arc-anvil-smoke.json`, `arc-foundry-installed.json` and `official-arc-sources.json`.

## Static analysis, coverage and gas

**Fresh Slither 0.11.6 assessment matches final source.** It reports 26 findings: 3 High, 8 Medium, 14 Low and 1 Informational. The detector/function inventory has no additions relative to the reviewed baseline. The three High pattern reports concern customer-authorized pull payments and the guarded exact-delta balance check; assumptions and adversarial evidence are documented, not suppressed. `--fail-none` means the zero process exit is not a zero-findings security certificate. Independent review remains a production gate.

**Fresh IR-minimum coverage passed** with actual native Arc execution, excluding only the separately verified invariant partition. Coverage for the two production contracts is:

- Escrow: lines **307/310 (99.03%)**, branches **70/72 (97.22%)**, functions **60/60 (100%)**.
- Manager: lines **218/223 (97.76%)**, branches **77/82 (93.90%)**, functions **29/29 (100%)**.

Coverage is explicitly **not 100% of all lines/branches**. The low whole-dependency aggregate includes unexercised third-party libraries and tooling; it is not substituted for production-file coverage. Initial stack-depth and IR timestamp-test failures are preserved. The expiry test now uses an explicit cheatcode timestamp/warp and asserts the deadline is past while retaining the expected `SignatureExpired` error.

**Fresh mock-EVM gas-report tests passed.** These are execution-cost measurements, not Arc network fee quotes. Arc `--gas-report` changed blocklisted-prank behavior; those initial failures remain preserved. Real signed local admission/recovery was checked separately instead of loosening assertions to hide the distinction.

**Final project typecheck and read-only lint passed**, with zero lint warnings/errors. Evidence: `final-checks.json`, `slither-approved-results.json`, `slither-approved-assessment.json`, `coverage-approved-result.json`, `coverage-approved.lcov`, `production-coverage.json` and `gas-report-approved-result.json`.

## Read-only deployment preparation

`contracts/script/mainnet/PrepareMainnet.s.sol` has no key loading, signing, CREATE or broadcast. Its **26 tests**, included in the 470 total, validate public configuration and rehearse reciprocal CREATE prediction, paused construction, roles, no direct deployer roles, pre-unpause limit changes and fail-closed invalid inputs.

The incomplete `arc-mainnet.template.json` intentionally has no invented Safe/signers/guardian/deployer/caps/addresses. Safe metadata/runtime-hash checks are not independent verification of its implementation/modules/guard/custody. The old generic CREATE2 scaffold is not an approved deployer for this immutable pair. See `contracts/script/mainnet/README.md` for the exact release gates.

## Boundaries and later work

- No Git add/commit/push, repository initialization, account/authentication changes, DNS/resource provisioning, paid-service activation, public-chain deployment or funded public-chain transaction occurred.
- Original `.env` hash is unchanged; no existing database was imported, reset or deleted. Private values were not printed.
- `AGENTS.md` was left untouched after a protected-file approval timeout; no alternative-path write was attempted. This report is the current phase-status reference.
- The target remains Arc mainnet without a testnet deployment. Read-only forks/local transactions do not change that agreement.
- The frontend still needs real transaction/consent UX and verified event ingestion. D1 financial writes remain fail-closed. Demo previews are not live settlement.
- Real governance/arbitrators/caps, independent security review/risk acceptance, approved small-value canaries, production accounts/secrets/email/DNS and operational readiness remain release gates, not completed Phase 3 deployment actions.
