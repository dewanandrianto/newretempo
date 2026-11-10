# Invariant remediation findings

## Verified diagnosis

No Solidity or Foundry configuration changes have been made. There is not yet evidence justifying a handler change without weakening the existing coverage guard.

- A fixed-seed (`0x1`), no-shrink ledger invocation with an isolated compiler cache still replays the repository's `cache/invariant/failures/EscrowInvariantTest/invariant_LedgerSumsAndCreditConservation`. It fails with `coverage: createAndFund never succeeded in this run` (Forge exit 1). The persisted sequence contains exactly one `openDispute` call, no creation/funding calls. The counters printed are zero for creation/funding and one for openDispute. See `invariant-repro.log`.
- Compiler cache isolation via `--cache-path` does **not** isolate invariant failure persistence. Fresh campaigns additionally require `FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR` pointing outside the source tree. The old counterexamples were preserved, not deleted.
- With an independently isolated failure-persistence directory, the same fixed-seed ledger invariant **passes at the existing 256 runs, depth 100: 25,600 calls, zero reverts**, Forge exit 0, 174.91 seconds. See `invariant-repro-clean.log`. No coverage or accounting assertion was changed.
- This proves the baseline coverage event can be caused by replaying a historical truncated counterexample, not a current inability to create/fund. It does not prove all fresh campaigns pass, nor establish why the historical counterexample was originally produced.
- A fresh all-invariant-path attempt exceeded the external tool's 600-second limit before emitting suite summaries (`invariants-before.log`); the tool returned exit 124. That attempt was terminated and is not a passing result.

## Bounded verification still running

The command below runs both invariant suites and their existing smoke tests using their original inline configuration (256 runs, depth 100), without disabling tests or coverage checks. Its Python wrapper enforces an 1800-second child timeout and records the actual Forge exit code, or 124 on timeout, in `invariants-fresh.log`.

```text
python3 /home/deseti/.hermes/cache/scratch/retempo-phase1-remediation-invariants/run.py invariants-fresh --match-path 'contracts/test/invariant/**' -v
```

The wrapper invokes:

```text
FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT=0 \
FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR=/home/deseti/.hermes/cache/scratch/retempo-phase1-remediation-invariants/failures-invariants-fresh \
/home/deseti/.local/share/retempo/toolchains/v1.7.1/forge test --offline \
 --out /home/deseti/.hermes/cache/scratch/retempo-phase1-remediation-invariants/out \
 --cache-path /home/deseti/.hermes/cache/scratch/retempo-phase1-remediation-invariants/cache \
 --fuzz-seed 0x1 --match-path 'contracts/test/invariant/**' -v
```

Process handle: `proc_b49872283f89` (handed off to parent). Read the completed log before asserting results. Full contract-suite verification has not been performed by this subagent. Phase 1 is not declared ready.

## Scope

Only remediation evidence was added under `docs/phase-1-evidence/remediation/`. No production contracts, test handlers, invariant assertions, coverage obligations, foundry.toml, deployment settings, credentials, or Git state were modified. TDD implementation was not started because no current handler defect has yet been established; making an arbitrary code change to force green would be unjustified.
