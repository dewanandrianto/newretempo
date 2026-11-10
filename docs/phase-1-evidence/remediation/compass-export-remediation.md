# Compass export helper remediation

## Outcome and scope

The exported deployment helper now passes root and backend TypeScript checks and read-only type-aware lint. Eight focused offline regression tests pass. No deployment, RPC request, wallet operation, transaction, dependency installation, package manifest edit, lockfile edit, or Git/auth change was performed. Tests run with Bun's `--no-env-file` flag and only import/parse the CLI; they do not call its deployment entry point.

Changed implementation: `scripts/compass-deploy.ts`. Added tests: `scripts/compass-deploy.test.ts`.

## Root cause

The export statically imported `getChain` from undeclared/unavailable `@circlefin/compass-chains`. TypeScript emitted TS2307, with seven cascading type-aware unsafe-operation lint errors. Importing the CLI failed even for offline argument parsing. The export also fixed every artifact/metadata/receipt path to `/home/user/app`, making the deployment helper nonportable.

The installed, already-declared `@circle-fin/app-kit` provides the public `@circle-fin/app-kit/chains` subpath with typed chain metadata and exact identifiers such as `Arc_Testnet` and `Base_Sepolia`. The helper now resolves exact EVM chain identifiers against those actual SDK exports. It does not construct or invent a chain definition, normalize malformed identifiers, or suppress type errors. Unknown and non-EVM identifiers fail closed.

App Kit's `explorerUrl` is a transaction URL template, not an address URL base. The existing `src/onchain-facts.ts` registry supplies the canonical explorer base for known chain IDs; for SDK-only EVM chains, the helper removes the trailing `/tx/{hash}` template before the existing `/address/` composition. Native currency remains the SDK's native currency, preserving Arc USDC gas (18 decimals) versus Base ETH gas, independently of ERC-20 USDC.

Repository paths now derive from `import.meta.url`, not shell cwd. Explicit `--artifact` arguments retain their original behavior. The obsolete private-key error path was replaced with an environment-based instruction; no private-key flow was executed. All deployment modes, verify-receipt guards, constructor validation, private-key explicit-RPC guard, and metadata override behavior remain in place.

## Official references inspected

- Arc: https://docs.arc.io/arc/references/connect-to-arc — Arc Testnet chain ID 5042002, USDC native gas, official RPC/explorer, built-in Viem chain support.
- Arc App Kits: https://docs.arc.io/app-kit/references/supported-blockchains — exact case-sensitive identifiers, including `Arc_Testnet`.
- Arc App Kits: https://docs.arc.io/app-kit/tutorials/adapter-setups — documented imports from `@circle-fin/app-kit/chains`.
- Circle: https://developers.circle.com/stablecoins/quickstarts/transfer-usdc-evm — deriving chain configuration from supported SDK chain definitions rather than invented definitions.
- Local references: `node_modules/@circle-fin/app-kit/package.json` public exports, `chains.d.mts`, actual SDK metadata inspected read-only; existing `src/onchain-facts.ts` chain-ID/SCP registry and `scripts/compass-deploy-helpers.ts` validation helpers.

## Regression evidence

- `compass-export-red.log`: initial CLI-import regression failed on missing `@circlefin/compass-chains`; baseline typecheck/lint diagnostics. The first test harness used `bun:test`, which the root node-only tsconfig did not expose; the final harness uses typed Node test/assert APIs without changing tsconfig.
- `compass-portability-red.log`: artifact-path regression failed with actual `/home/user/app/...` versus the repository-relative expected path, before the path implementation changed.
- `compass-export-green.log`: final real execution output and individual exit statuses.

Final commands (repository root):

```sh
/home/deseti/.local/share/retempo/toolchains/bun-v1.3.14/bun --no-env-file test scripts/compass-deploy.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc --noEmit -p backend
./node_modules/.bin/oxlint --type-aware src scripts
./node_modules/.bin/oxlint .
```

All five commands exited 0; focused tests: **8 passed, 0 failed**. No `--fix` lint command was used.

The focused tests cover import/CLI parsing, repository-relative paths from a different cwd, Arc and Base chain metadata/native gas, SDK-only explorer-template conversion, unknown/case/whitespace/non-EVM rejection, explicit artifact/metadata-override argument acceptance, missing chain flags, invalid gas-token overrides, and the private-key explicit-RPC safety guard.

## Limitations

This repairs the static export/typecheck/lint blocker; it is not evidence that a live deployment works or is approved. Other `@circlefin/compass-*` deployment engines are still dynamically loaded by the existing runtime flow. They were neither installed nor exercised, and no claims of their availability or mainnet readiness are made. The exported chain registry was not modified. Git history/status inspection was unavailable because this exported workspace is not a Git repository.
