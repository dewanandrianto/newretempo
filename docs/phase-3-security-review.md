# Phase 3 Security Review — Findings and Remediation

This is an author-assisted source review with executable local evidence, **not an independent audit**. The owner chose both financial-policy changes before production source was modified. Phase 3 local remediation/validation is complete; this does not authorize deployment or certify absence of vulnerabilities.

## M-1 — Missing renewed consent for future dispute-window changes

**Severity:** Medium, policy-dependent. **Status:** Remediated under the owner-selected policy; final functional, manager invariant and integration checks passed.

Before remediation, an existing recurring mandate could fund a new escrow with governance-changed response/resolution windows, without a changed mandate generation or customer reacceptance. Existing funded escrows retained their old snapshots. The original executable reproduction remains in `docs/phase-3-evidence/policy-evidence.log`; its old test names describe the pre-fix source, not the current file.

The manager now stores per-subscription accepted windows separately from existing subscription/mandate layouts. Manual and recurring paths fail closed on changed windows before debit/counters/spend/funding. `acceptEscrowTerms` requires the active escrow subscription's customer, an unpaused manager, and exact expected current windows. Changed acceptance revokes an active mandate; it does not silently authorize another budget. Unchanged acceptance cannot reset spent/nonce/active state.

Verification: all **18** tests in `contracts/test/RetempoConsent.t.sol`, `test_ChangedDisputeWindowsCannotDebitAnExistingMandate` in `RetempoPolicyEvidence.t.sol`, the complete native Arc functional partition, final manager stateful invariants, pinned mainnet-fork cases and signed local transaction acceptance passed. Exact ABI/error/event/reason changes and the initial-subscription execution-time quote limitation are documented in `docs/phase-3-contract-api.md`.

## M-2 — Arbitration remained possible after its resolution deadline

**Severity:** Medium, policy-dependent. **Status:** Remediated under the owner-selected exclusive-deadline policy; final boundary, fuzz and escrow invariant checks passed.

Before remediation, both a late arbitrator ruling and permissionless timeout expiration could allocate the same frozen funds; transaction ordering selected the winner. Original exact-deadline/after-deadline reproductions are preserved in `policy-evidence.log`.

`resolveDispute` now rejects `block.timestamp >= disputedAt + resolutionTimeout` with `ResolutionWindowEnded()`, before any frozen-fund allocation. Before the deadline, existing response-window, arbitrator and role checks still apply. At/after it, expiration is permissionless and deterministic. There is no automatic state transition merely because time passed. Existing mutually authorized settlement rights are unchanged; this fix ends unilateral late arbitrator authority rather than disabling the parties' settlement path.

Verification: before/exact/after deadline regressions in `RetempoPolicyEvidence.t.sol`, a **1,000-run** carving/conservation fuzz test that now checks late rejection plus deterministic expiry, all escrow regressions and final escrow invariants passed. No conservation assertion was removed to accommodate the change.

## Final Slither assessment

Fresh Slither **0.11.6** matches current production source and reports **26 findings: 3 High, 8 Medium, 14 Low, 1 Informational**. There are no added detector/function signatures relative to the reviewed baseline. The raw findings were retained, not suppressed. `--fail-none` records a scan result; its exit zero is not a clean security certificate.

- **Two High `arbitrary-send-erc20`:** permissionless recurring execution pulls from a customer fixed by customer-created subscription state, bounded by fixed price/cadence, explicit finite mandate, cap, expiry, allowance and balance. Recipient paths are fixed to the merchant payout or linked escrow, never the executor. Absent/revoked/expired/exhausted mandates, unauthorized renewals, redirection and duplicate charges are tested. Accepted as the intended pull-payment pattern under those assumptions, not proof of arbitrary victim selection.
- **One High `reentrancy-balance`:** the manager compares balance around calls to immutable escrow/USDC. Payment entrypoints are nonReentrant; deposit delta, returned key, exhausted allowance and preserved manager balance are checked, with adversarial-token evidence. This assessment requires the approved Arc USDC and correctly linked reviewed escrow. Supporting another token/callback model requires a fresh review.
- **Four Medium strict-equality reports:** zero-amount guards, not equality assumptions about the contract's entire token balance.
- **Four Medium uninitialized-local reports:** Solidity zero-default memory structs/keys, assigned/checked on the relevant paths.
- **Fourteen Low timestamp reports:** deliberate billing/vesting/dispute timing, with exact boundaries tested. Timestamp use is not dismissed as universally harmless.
- **One Informational complexity report:** the reason-to-error dispatcher.

Evidence: `slither-approved-results.json`, `slither-approved-run.json`, `slither-approved-assessment.json`, and `slither-approved.log`. Historical exported `SLITHER-ANALYSIS.md` is not substituted for this run or an independent audit.

## Final verification and residual limits

The current inventory reconciles to **470 unique tests passed, 0 failed, 0 skipped**, including all 16 stateful invariants at the original 256 runs/depth 100. Actual compiled source-dependency graphs match current source; see `artifact-attestation.json` and `test-reconciliation.json`.

Fresh signed localhost Arc Anvil testing confirms that the tested blocklisted EOA cannot send even a zero-value transaction, while a clean relayer can recover **already-created** credit through beneficiary-signed payout authorization. Internal prank calls do not prove new claims/refunds are possible for blocked senders. Issuer pause/escrow-wide blocklisting can still halt everyone, and no admin sweep bypass exists.

Other residual risks: initial subscription windows are captured at execution rather than committed in the existing initial subscription ABI; immutable deployment linkage cannot be repaired; unsolicited transfers are not sweepable; direct-plan merchants control future revenue payout; arbitrator independence and real admin/Safe implementation/modules/guard/custody need operational review. No real Safe, signer, guardian, arbitrator or business cap was invented from test fixtures.

Independent security review/risk acceptance and separately approved production deployment/canaries remain release gates. The user has not authorized a public-chain transaction or Git publication through this phase.
