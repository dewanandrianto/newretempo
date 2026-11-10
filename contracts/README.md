# Retempo Contracts

The source contains two substantive, non-upgradeable Solidity contracts:

- `RetempoSubscriptionManager.sol`: merchant plans, customer subscriptions, manual payments and explicitly authorized finite recurring mandates.
- `RetempoEscrow.sol`: accepted funding terms, linear vesting, pull-ledger credits, refunds, partial dispute freezes, arbitration, bilateral settlement, payout authorization and withdrawal.

**No production contract address is configured and nothing is deployed by this workspace's local test commands.** The agreed target is Arc **mainnet**, without a testnet deployment. Mainnet deployment, funded canaries and unpausing require separate explicit approval.

## Toolchain and money model

Phase 3 local validation is complete: 470 unique tests passed, including all 16 stateful invariants at their original run/depth settings. See `docs/phase-3-verification.md` and `docs/phase-3-security-review.md` for exact results and residual limits. Verified durable artifacts live in `contracts/contract-metadata/phase-3-build/`; generated ABI is in `contracts/abi/`. Neither location contains a deployed production address or broadcast approval.

- Solidity 0.8.28, Cancun target, optimizer enabled with 200 runs, as pinned by `foundry.toml`.
- OpenZeppelin Contracts from the project lockfile; forge-std for testing/scripts.
- Standard Forge runs ordinary EVM/mock-token tests. Official Arc Foundry `v0.8.0-4` with `--network arc --chain-id 5042` supplies Arc's native USDC runtime for the Arc-specific tests.
- ERC-20 USDC: `0x3600000000000000000000000000000000000000`, **6 decimals**. Native gas balance uses **18 decimals** backed by the same underlying asset. Do not interpret `address.balance` as ERC-20 base units or double-count transfer emitters.

The official mainnet RPC was queried **read-only** during Phase 3: chain ID 5042, deployed USDC code and 6 decimals were checked. The Arc-specific suite was also executed on a pinned mainnet fork **locally**, with no remote transaction broadcast. Evidence is under `docs/phase-3-evidence/`.

## Local checks

```bash
FORGE_BIN=/path/to/arc-forge bash scripts/check-contracts-local.sh --network arc --chain-id 5042 --summary
```

Use the official pinned Arc binary, not an arbitrary executable named Forge. The helper uses a fresh replay directory, fixed seed and isolated generated output. It does not lower invariant run/depth settings or deploy anything. Ordinary Forge alone does not prove Arc-native behavior.

Arc rejects impossible transaction senders before EVM execution. The invariant harness uses a valid outer dispatcher EOA; handlers still select/prank the full protocol actor set themselves. Zero-valued function arguments, negative paths, assertions and weighted selectors remain fuzzed; 256 runs and depth 100 are unchanged. Compiler-dependency attestations and exact inventory reconciliation establish what the passing partitions exercised.

## Deployment preparation

- [Read-only inspector and operational gates](script/mainnet/README.md).
- `script/mainnet/PrepareMainnet.s.sol`: explicit public-parameter inspection and address prediction only; no key loading, signing, broadcast or CREATE.
- `contract-metadata/arc-mainnet.template.json`: intentionally incomplete production manifest. Missing Safe/signers/guardian/limits/addresses are blockers, not values to invent.
- `test/PrepareMainnet.t.sol`: local rehearsal of exact CREATE linkage, paused deployment, roles and pre-unpause limits, plus fail-closed negative cases.

Do not use the old generic CREATE2 scaffold for the Retempo mainnet system. It is not a reviewed deployment workflow for this pair of immutable contracts.

## Security and remaining production gates

Automated tests, Slither and an author review are **not an independent audit**. A passing local test is not proof of production availability, governance security, email delivery, event indexing, or wallet integration.

Important residual risks include USDC issuer pause/blocklisting, immutable linkage, irrecoverable unsolicited transfers (no sweep by design), merchant-controlled direct-plan payout changes, and operational signer/arbitrator trust. Blocklisted sender recovery must be assessed with real local transaction validation, not only internal `vm.prank` calls. Native/gas instrumentation limitations are recorded in the phase evidence rather than hidden by weakened assertions.

The old `RETEMPO-*-design.md`, integration plan and `SLITHER-ANALYSIS.md` are imported historical documents. Their phase numbers, "owner-approved" wording and execution claims are not current authorization. The active backend is Workers/Hono + D1/Drizzle; financial writes remain fail-closed pending the later verified-event integration. Never reuse the legacy PostgreSQL authority flag as a D1 mechanism.
