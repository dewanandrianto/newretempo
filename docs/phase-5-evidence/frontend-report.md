# Frontend bundle hardening — local evidence

This is the frontend workstream only, not a declaration that Phase 5 or production readiness is complete. The parent acceptance runner owns the final actual-browser/two-Worker/signed-Arc scenario. Historical Phase 4 evidence was not overwritten.

## Measured outcome

Both measurements used actual fresh production builds. `frontend-before-assets.json` and `frontend-after-assets.json` include the emitted manifest, initial graph roots/static edges, exact asset bytes, per-asset gzip bytes and SHA-256 hashes. `frontend-summary.json` records reductions, executed exit codes and final owned-source fingerprints.

| Measurement | Before | After |
| --- | ---: | ---: |
| Initial JavaScript assets | 1 | 1 |
| Initial JavaScript payload, uncompressed bytes | 2,245,401 | 687,028 |
| Initial JavaScript payload, gzip bytes | 641,353 | 208,179 |
| All emitted JavaScript assets, including deferred assets | 82 | 130 |
| All emitted JavaScript, uncompressed bytes | 3,495,709 | 3,526,447 |
| Transformed modules | 9,025 | 9,027 |

Initial JavaScript decreased **69.40% uncompressed / 67.54% gzip**. These are asset-payload measurements, not measured HTTP wire bytes or a page-load timing claim. The measurement starts with the actual emitted `index.html` scripts/modulepreloads and follows recursive manifest static `imports`, deduplicating filenames. It excludes `dynamicImports`, CSS, images, HTTP headers, cache behavior and deferred selected-route requests. Gzip uses Node zlib's default compression independently for each asset. Both actual initial graphs have one entry and no further static edges; no manually split/all-preloaded vendor graph is hiding additional initial assets.

## Import inspection and implementation

- The previous router eagerly imported every customer, merchant and authentication page/layout. `main.tsx` eagerly installed Wagmi and ConnectKit even on the public landing page.
- Authentication, customer and merchant pages/layouts now use React lazy imports. Existing grouped source modules (`AccountPages`, catalog, customer and money pages) retain their named exports and shared chunks; no feature was removed.
- A stable lazy `WalletRoutes` layout wraps all wallet-consuming application routes with the **real existing** `WagmiProvider`, configuration and `ConnectKitProvider`. QueryClient/AuthProvider remain shared above the route tree. Wallet context does not remount when navigating between application routes. The landing page has no wallet consumers and no longer downloads the wallet provider/chunks.
- A dark, responsive Suspense loading state and error boundary prevent a blank page on delayed/rejected route imports. Errors offer a full reload (which can retrieve a changed deployment's manifest/assets) and a home link; neither submits a transaction. No unrelated forms or page design were changed.
- Inspection found **no frontend `@circle-fin/*` imports**. Circle packages remain declared for approved ecosystem/tooling uses. No Circle/protocol dependency, lockfile, contract or ABI was removed. ConnectKit/Wagmi, connectors, Viem, charts, icons and animation remain real dependencies; transformed-module count is therefore effectively unchanged.
- Arc transport and tracing registration explicitly use `https://rpc.mainnet.arc.io`; Ethereum mainnet/ENS transport explicitly uses `https://cloudflare-eth.com`. This is an offline configuration regression, not proof of public RPC availability/CORS from this environment. No remote chain write was made.
- Vite emits a manifest for repeatable measurement. Default chunk warning thresholds are unchanged; no manual vendor splitting or route prefetch was added.

## Red/green and verification

- `frontend-build-red.log`: the deterministic emitted-graph test failed on the fresh baseline's 641,353 gzip bytes (budget: 250 KiB). It now also requires WalletRoutes, CheckoutPage and OverviewPage to be dynamic entries absent from the initial graph.
- `frontend-routes-red.log`: the actual production-preview browser test reproduced the missing route-error fallback. The delayed-route test already passed with Suspense. An initial wallet selector was corrected from “connect wallet” to the existing “Continue with wallet”; the final test also opens the **real ConnectKit dialog**.
- `frontend-rpc-red.log`: the offline transport regression failed because the installed implicit Ethereum mainnet default was `https://ethereum.reth.rs/rpc`; both explicit transport assertions now pass. Browser-only Studio tracing is mocked solely to allow this configuration test to import in Node.
- `frontend-green.log`: **4 passing checks** — emitted byte budget/dynamic graph, genuinely delayed route chunk followed by real route rendering, aborted route chunk with visible error/home recovery, and landing-to-login navigation loading the real provider and opening ConnectKit.
- `frontend-wallet-tests.log`: **29 passing wallet/SDK/model tests**, consisting of all previous 28 plus the RPC regression.
- `frontend-typecheck.log`, `frontend-test-typecheck.log`: root/frontend and wallet-test TypeScript exit zero.
- `frontend-lint.log`: scoped type-aware source/config lint and normal lint of the new JavaScript measurement/browser harness exit zero.
- `frontend-public-browser.log`, `frontend-public-fixtures/`: **7 passing actual-browser HTTP-fixture tests**, including disabled checkout at 320/360/390/768/1440 px, invalid invoice capability and disabled portal. These do not claim settlement.
- `frontend-after-build.log`: final fresh production build exits zero. Dependency annotation and >500 kB chunk warnings remain and are not suppressed.

The attempted broader type-aware lint of the entire `tests/onchain` directory is retained in `frontend-broad-test-lint-attempt.log`: it also applies TypeScript safety rules to untyped browser `.mjs` fixtures (existing and new) and flags existing merchant API test helpers. The project's production lint runs type-aware checks on `src scripts worker` and ordinary lint on the remainder; no lint rule was disabled to hide this experiment. Scoped production/config checks and normal new-harness lint pass.

## Reproduction

Run from `/home/deseti/projects/retempo`. `BUN` below denotes the pinned `/home/deseti/.local/share/retempo/toolchains/bun-v1.3.14/bun`, always with `--no-env-file`.

```sh
$BUN --no-env-file run build
node tests/onchain/frontend-assets.mjs dist docs/phase-5-evidence/frontend-after-assets.json
node --test tests/onchain/frontend-build.test.mjs tests/onchain/frontend-routes.browser.test.mjs
$BUN --no-env-file node_modules/vitest/vitest.mjs run --config tests/onchain/vitest.config.ts
$BUN --no-env-file node_modules/typescript/bin/tsc --noEmit
$BUN --no-env-file node_modules/typescript/bin/tsc --noEmit -p tests/onchain
$BUN --no-env-file node_modules/oxlint/bin/oxlint --type-aware src/app src/main.tsx src/config.ts tests/onchain/config.test.ts vite.config.ts
$BUN --no-env-file node_modules/oxlint/bin/oxlint tests/onchain/frontend-assets.mjs tests/onchain/frontend-build.test.mjs tests/onchain/frontend-routes.browser.test.mjs
```

The route-browser suite owns and stops a loopback production preview on port 4327, using the already-installed local Playwright/Chrome. For the existing public fixture suite, run a production preview on a free loopback port, set `RETEMPO_PREVIEW_URL` and `RETEMPO_BROWSER_EVIDENCE_DIR=docs/phase-5-evidence/frontend-public-fixtures`, then run `node --test tests/onchain/public.browser.test.mjs`; the recorded execution used port 4328 and stopped its owned preview afterward.

## Known limits and remaining gates

- This optimizes initial landing/bootstrap JavaScript, not the aggregate download of every feature. Entering a wallet route still downloads the real wallet SDK and selected-page dependencies. Total emitted JavaScript increased slightly with route/chunk wrappers; this is intentional deferral, not dependency elimination.
- The landing bootstrap still contains shared React/router/query/auth, icons/charts/animation and related UI code. It remains larger than 500 kB raw; further optimization is possible. No unsupported total-bundle or runtime-speed claim is made.
- Browser failure fixtures intentionally abort a local asset and return explicit HTTP API fixtures. They are not public RPC, chain identity, funded-wallet, financial settlement or production free-tier acceptance.
- Final signed browser acceptance, public RPC availability/CORS, full-project final checks and the remaining Phase 5 workstreams remain with the parent. No deployment, account action, Git operation, paid service or remote-chain write was performed.
