# Arc Mainnet Preparation — No Broadcast

`PrepareMainnet.s.sol` is a **read-only inspector**, not a deployment script. It contains no broadcast/signing/key-loading or contract creation operations. Passing its checks is not permission to transact.

## Required public inputs

The incomplete manifest is `contracts/contract-metadata/arc-mainnet.template.json`. It deliberately contains no invented admin, signers, guardian, deployer, contract addresses, limits, or transaction hashes. Do not replace missing values with fixture addresses from tests.

The `run()` entrypoint reads every value explicitly:

- `ARC_MAINNET_RPC_URL`: exactly `https://rpc.mainnet.arc.io`.
- `RETEMPO_USDC`: exactly `0x3600000000000000000000000000000000000000`; the current runtime must report code and 6 ERC-20 decimals.
- `RETEMPO_ADMIN`: the separately approved admin contract.
- `RETEMPO_ADMIN_RUNTIME_CODE_HASH`: separately approved runtime bytecode hash; not an automatic attestation of a secure Safe.
- `RETEMPO_ADMIN_OWNERS`: comma-separated addresses matching the approved ordered `getOwners()` response.
- `RETEMPO_ADMIN_THRESHOLD`: at least two, matching the onchain metadata and bounded by the owner count.
- `RETEMPO_ADMIN_DELAY_SECONDS`: at least three days, within uint48. This is a preparation safety policy, not a claim that the user has selected final production governance.
- `RETEMPO_PAUSER`: a nonzero guardian different from both admin and deployer.
- `RETEMPO_DEPLOYER`: a public address only, different from the admin; no key is loaded.
- `RETEMPO_DEPLOYER_NONCE`: the exact current nonce, within the range that allows both CREATE operations.
- `RETEMPO_MAX_AGGREGATE_EXPOSURE`: explicitly approved positive ERC-20 base-unit exposure ceiling.
- `RETEMPO_LAUNCH_MAX_PAYMENT_AMOUNT`: explicitly approved integer base-unit ceiling, at least 0.01 and no more than 10,000 USDC under this preparation policy. A later canary must use a separately approved small value, not this maximum by default.

The current chain must be **5042**. Supply an explicit mainnet read-only fork when running the inspector; a matching URL string alone cannot prove the state came from that URL. The inspector neither chooses a remote provider nor silently connects to one. `inspect()` is also exercised against isolated local Arc state in tests.

## What the inspector actually verifies

- Chain, exact configured RPC URL string, USDC address/code/decimals.
- Admin code exists and matches the approved runtime hash; exposed owners/threshold match the approved manifest.
- No zero/duplicate signers, role overlap, unsafe nonce truncation or missing monetary limit.
- The deployer nonce has not changed.
- Predicted escrow/manager CREATE addresses have neither code nor a nonzero nonce.
- Prediction does not deploy contracts, consume nonces, change balances or assign roles.

**Not independently verified:** Safe proxy/implementation authenticity, upgradeability, enabled modules, guard/fallback behavior, signer key custody and operator approval. A malicious contract can imitate Safe metadata; these external checks remain mandatory. The template keeps them false/unset rather than suggesting this inspector proves them.

## Deployment order and operational gates

1. Freeze compiler settings, source and dependency hashes; independently review the release bytecode.
2. Verify real admin implementation/modules/signers, guardian, arbitrators, caps, RPC chain ID, USDC and public deployer nonce. Verify no pending transaction can consume that nonce.
3. Obtain explicit deployment and gas approval. Phase 3 local authorization is not that approval.
4. In the separately reviewed deployment workflow, create escrow at deployer nonce N with immutable manager predicted at N+1, then create manager at N+1 linked to the actual escrow. No interleaving transaction is allowed. There is no linkage setter to repair a wrong deployment.
5. Verify actual addresses, chain, code, constructor arguments, reciprocal immutable linkage, six-decimal token, paused state, all roles and admin delay. The deployer must retain no direct role.
6. Both constructors initially use a 10,000-USDC per-item ceiling. While still paused, the approved admin must apply the approved lower launch limit to **both** manager and escrow and verify the aggregate exposure ceiling. Do not mistake preparation input for an already-applied setting.
7. Independently approve/allowlist arbitrators and verify conflict rules. An allowlist does not replace each customer's explicit acceptance.
8. Verify explorer source/bytecode and configure the real addresses only after successful readback. Approve a small-value canary and unpause separately. Do not enable public flows until event reconciliation and the application integration are complete.

`contracts/test/PrepareMainnet.t.sol` rehearses construction, linkage, paused role assignment, absence of deployer roles, and applying launch limits while paused. Its Safe-like contract and all addresses are **test fixtures only**, not production governance evidence.

## Reproducible local tests

Use the pinned official Arc Foundry release and fresh invariant replay storage:

```bash
FORGE_BIN=/path/to/arc-forge bash scripts/check-contracts-local.sh --network arc --chain-id 5042 --summary
```

Run the preparation test alone by adding `--match-path contracts/test/PrepareMainnet.t.sol`. This local test runner does not connect to a remote chain unless a fork URL is explicitly added, and never broadcasts a transaction.

Do not use the old generic `DeployCreate2.s.sol`/`Create2Factory.sol` scaffold for this deployment. It does not validate this system's reciprocal linkage, roles, manifests, paused configuration or approval gates.
