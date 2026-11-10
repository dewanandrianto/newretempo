# Phase 5 — bounded dependency-advisory triage

**Status: audit exit 1; findings remain. This is not an audit pass or Phase 5 completion.**

Captured audit: **9 package names, 37 unique advisories** (15 high, 6 low, 16 moderate). Installed versions verified against all **49 lock instances** of these names: **41 affected instances / 149 instance-advisory matches**. These are lock findings, not demonstrated production exploits.

## Runtime exposure verified

- Public Worker (`worker/src/index.ts`): only root **Zod 4.6.7** from the flagged names is emitted; it is patched. No affected flagged package emitted.
- Private Worker (`chain-worker/src/index.ts`): none of the flagged packages emitted.
- Browser: fresh Vite build, **9023 transformed modules / 131 emitted JS chunks**, inspected all dynamic chunks, retained **none** of the nine flagged package names. Zod and UUID appear in the parsed graph but are tree-shaken out; parsed imports alone would give a false production exposure result.
- Node SDK/deployment/config and dev-tool paths remain in the lock. Root dependencies are not equivalent to runtime bundle reachability. No account-bearing SDK/deployment helper was executed.

## Package-specific decisions

### @grpc/grpc-js

- Advisory IDs: [GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j) (high), [GHSA-f596-whhp-79r4](https://github.com/advisories/GHSA-f596-whhp-79r4) (low)
- Exact resolved versions: 1.9.16
- Lock-only Node Firebase branch; no gRPC server or certificate API is bundled into either Worker or emitted browser. The server-specific advisory preconditions are not established for this app.
- **Action:** Candidate scoped @grpc/grpc-js 1.9.16 -> 1.13.6 (minor; CJS retained, Node >=12.10). Firebase requests ~1.9.0, so override is outside its declared range and requires Firebase/Circle regression tests. 1.14.0-1.14.4 are also affected upstream: do not choose them. No source/lock change made.

Representative exact installed dependency paths:

- `@circle-fin/w3s-pw-web-sdk@1.1.11` → `firebase@10.14.1` → `@firebase/firestore@4.7.3` → `@grpc/grpc-js@1.9.16` — affected; `node_modules/@grpc/grpc-js/package.json`.

Every nested instance, exact direct-parent range and shortest root path is enumerated in `dependency-triage.json`; representative paths above are not an exhaustive list.

### decode-uri-component

- Advisory IDs: [GHSA-qr28-fpjm-wq7f](https://github.com/advisories/GHSA-qr28-fpjm-wq7f) (high), [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr) (moderate)
- Exact resolved versions: 0.2.2
- Lock-only query-string branch, not emitted browser or Workers. DoS needs attacker-controlled malformed encoded input passed into this decoder, not merely a native URL parse.
- **Action:** First release fixing both advisories is 0.5.1. No patched 0.2.x release found. Do NOT blindly override 0.2.2 -> 0.5.1: 0.5.1 is ESM-only while query-string 7.1.3 requires CommonJS. A consumer-compatible migration/backport is an unresolved gate, not an approved patch/minor fix.

Representative exact installed dependency paths:

- `wagmi@2.19.5` → `@wagmi/connectors@6.2.0` → `@walletconnect/ethereum-provider@2.21.1` → `@walletconnect/utils@2.21.1` → `query-string@7.1.3` → `decode-uri-component@0.2.2` — affected; `node_modules/decode-uri-component/package.json`.

Every nested instance, exact direct-parent range and shortest root path is enumerated in `dependency-triage.json`; representative paths above are not an exhaustive list.

### elliptic

- Advisory IDs: [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84) (low)
- Exact resolved versions: 6.6.1
- Lock-only ethers-v5/signing and Node crypto-browserify polyfill branches. Vite transforms none of elliptic; neither Worker includes it. Actual Arc signing uses approved viem/injected wallet flow, not this library. Absence in these bundles does not justify using it in future server signing.
- **Action:** No patched release: registry latest is 6.6.1 and GHSA has no first_patched_version. Preserve approved Circle SDKs. Keep elliptic away from funded-key/signature code; upstream replacement/backport or explicit reviewed non-reachability disposition required.

Representative exact installed dependency paths:

- `vite-plugin-node-polyfills@0.22.0` → `node-stdlib-browser@1.3.1` → `crypto-browserify@3.12.1` → `browserify-sign@4.2.6` → `elliptic@6.6.1` — affected; `node_modules/elliptic/package.json`.

Every nested instance, exact direct-parent range and shortest root path is enumerated in `dependency-triage.json`; representative paths above are not an exhaustive list.

### esbuild

- Advisory IDs: [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) (moderate)
- Exact resolved versions: 0.18.20, 0.25.12, 0.28.2
- Only @esbuild-kit/core-utils nested 0.18.20 is affected. Root 0.28.2 and Vite/drizzle-kit nested 0.25.12 are not. This is development server exposure, not emitted application code; using transform to build is not evidence that the vulnerable serve API runs.
- **Action:** Candidate scoped @esbuild-kit/core-utils>esbuild 0.18.20 -> 0.25.12 (0.x minor jump, NOT guaranteed API-compatible). Scratch-only module substitution successfully exercised core-utils.transformSync on TypeScript. Require full Drizzle generate/migration-helper regression in isolated scratch before an override. First patched is 0.25.0; no patched 0.18.x. Never downgrade root or Vite esbuild.

Representative exact installed dependency paths:

- `@cloudflare/vitest-plugin@1.6.0` → `esbuild@0.28.2` — not in captured vulnerable ranges; `node_modules/esbuild/package.json`.
- `drizzle-kit@0.31.11` → `@esbuild-kit/esm-loader@2.6.5` → `@esbuild-kit/core-utils@3.3.2` → `esbuild@0.18.20` — affected; `node_modules/@esbuild-kit/core-utils/node_modules/esbuild/package.json`.
- `drizzle-kit@0.31.11` → `esbuild@0.25.12` — not in captured vulnerable ranges; `node_modules/drizzle-kit/node_modules/esbuild/package.json`.

Every nested instance, exact direct-parent range and shortest root path is enumerated in `dependency-triage.json`; representative paths above are not an exhaustive list.

### stream-json

- Advisory IDs: [GHSA-hqr4-qq8f-hg3x](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x) (moderate), [GHSA-mjw6-4jj6-33hc](https://github.com/advisories/GHSA-mjw6-4jj6-33hc) (moderate), [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x) (moderate)
- Exact resolved versions: 1.9.1
- Lock-only jayson Node stream-parser branch. Browser entry uses jayson browser/client, which is not proof of streaming-server reachability. Bounded direct installed-code check confirmed local parsed-object prototype injection in 1.9.1, not global Object.prototype pollution. No Workers/browser inclusion. JSONC advisory describes APIs absent from 1.x; broad audit range is retained, not treated as proof every advisory mechanism exists in 1.9.1.
- **Action:** All listed fixes require stream-json >=3.6.0; no patched 1.x release found. Do NOT override jayson ^1.9.1 to 3.6.0: ESM, changed subpaths/API and stream-chain major change; jayson requires stream-json/streamers/StreamValues and utils/Verifier. Upstream compatible backport/consumer fix remains a gate.

Representative exact installed dependency paths:

- `@circle-fin/adapter-viem-v2@1.20.1` → `@solana/web3.js@1.99.0` → `jayson@4.3.0` → `stream-json@1.9.1` — affected; `node_modules/stream-json/package.json`.

Every nested instance, exact direct-parent range and shortest root path is enumerated in `dependency-triage.json`; representative paths above are not an exhaustive list.

### toml

- Advisory IDs: [GHSA-82x6-q7mm-w9cf](https://github.com/advisories/GHSA-82x6-q7mm-w9cf) (high), [GHSA-v5mp-jgw5-2x6j](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j) (high), [GHSA-4qx8-w7c3-pj3p](https://github.com/advisories/GHSA-4qx8-w7c3-pj3p) (high), [GHSA-9j65-hcg3-gc64](https://github.com/advisories/GHSA-9j65-hcg3-gc64) (high), [GHSA-9qmh-m7c6-f92p](https://github.com/advisories/GHSA-9qmh-m7c6-f92p) (high)
- Exact resolved versions: 3.0.0
- Lock-only Anchor workspace configuration branch. Source package workspace.js imports toml to parse local Anchor.toml; neither Worker nor emitted browser contains it. A malicious local/deployment config would be a separate trust boundary, not a public JSON request exploit.
- **Action:** First release fixing all five findings is 5.0.1 (Node >=20). No patched 3.x release found. Anchor requests ^3.0.0; 3 -> 5 is a major upgrade, outside permitted blind patch/minor remediation. Require upstream compatible backport or reviewed Anchor API migration, retaining approved SDKs.

Representative exact installed dependency paths:

- `@circle-fin/app-kit@1.21.0` → `@coral-xyz/anchor@0.31.1` → `toml@3.0.0` — affected; `node_modules/toml/package.json`.

Every nested instance, exact direct-parent range and shortest root path is enumerated in `dependency-triage.json`; representative paths above are not an exhaustive list.

### undici

- Advisory IDs: [GHSA-c76h-2ccp-4975](https://github.com/advisories/GHSA-c76h-2ccp-4975) (moderate), [GHSA-g9mf-h72j-4rw9](https://github.com/advisories/GHSA-g9mf-h72j-4rw9) (moderate), [GHSA-cxrh-j4jr-qwg3](https://github.com/advisories/GHSA-cxrh-j4jr-qwg3) (low), [GHSA-f269-vfmq-vjvj](https://github.com/advisories/GHSA-f269-vfmq-vjvj) (high), [GHSA-2mjp-6q6p-2qxm](https://github.com/advisories/GHSA-2mjp-6q6p-2qxm) (moderate), [GHSA-vrm6-8vpv-qv8q](https://github.com/advisories/GHSA-vrm6-8vpv-qv8q) (high), [GHSA-v9p9-hfj2-hcw8](https://github.com/advisories/GHSA-v9p9-hfj2-hcw8) (high), [GHSA-4992-7rv2-5pvq](https://github.com/advisories/GHSA-4992-7rv2-5pvq) (moderate), [GHSA-8xcm-r25x-g524](https://github.com/advisories/GHSA-8xcm-r25x-g524) (moderate), [GHSA-m8rv-5g2x-5cg5](https://github.com/advisories/GHSA-m8rv-5g2x-5cg5) (moderate), [GHSA-v3r7-h72x-cjcm](https://github.com/advisories/GHSA-v3r7-h72x-cjcm) (moderate), [GHSA-p88m-4jfj-68fv](https://github.com/advisories/GHSA-p88m-4jfj-68fv) (moderate), [GHSA-g8m3-5g58-fq7m](https://github.com/advisories/GHSA-g8m3-5g58-fq7m) (low), [GHSA-35p6-xmwp-9g52](https://github.com/advisories/GHSA-35p6-xmwp-9g52) (low), [GHSA-r53p-7pc4-xj5r](https://github.com/advisories/GHSA-r53p-7pc4-xj5r) (low), [GHSA-rfgv-xxqx-mfg5](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5) (high), [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685) (moderate), [GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) (high), [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm) (high), [GHSA-9fm3-97px-rjf6](https://github.com/advisories/GHSA-9fm3-97px-rjf6) (moderate), [GHSA-vxpw-j846-p89q](https://github.com/advisories/GHSA-vxpw-j846-p89q) (high)
- Exact resolved versions: 6.19.7, 7.30.1
- Only Firebase nested 6.19.7 copies are affected by these audit ranges; root Miniflare 7.30.1 is outside all listed ranges/current GHSA 7.x ranges. Neither Worker bundles Undici: workerd native fetch is not npm Undici. Browser Firebase/node transport is absent.
- **Action:** Candidate scoped overrides for five @firebase/* parents: undici 6.19.7 -> 6.29.1 (same-major minor; Node >=18.17 unchanged). Firebase pins 6.19.7, so validate Node SDK HTTP/WebSocket/auth/storage behavior; do not globally override/downgrade Miniflare 7.30.1 or jump to latest 8.x.

Representative exact installed dependency paths:

- `@cloudflare/vitest-plugin@1.6.0` → `miniflare@5.20261104.0-beta` → `undici@7.30.1` — not in captured vulnerable ranges; `node_modules/undici/package.json`.
- `@circle-fin/w3s-pw-web-sdk@1.1.11` → `firebase@10.14.1` → `@firebase/auth@1.7.9` → `undici@6.19.7` — affected; `node_modules/@firebase/auth/node_modules/undici/package.json`.

Every nested instance, exact direct-parent range and shortest root path is enumerated in `dependency-triage.json`; representative paths above are not an exhaustive list.

### uuid

- Advisory IDs: [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) (moderate)
- Exact resolved versions: 11.1.1, 14.0.3, 8.3.2, 9.0.1
- Affected nested copies are 8.3.2 and 9.0.1; root 11.1.1 and unified-balance-kit 14.0.3 are safe for this GHSA. Parsed MetaMask UUID modules are tree-shaken out of emitted chunks. GHSA concerns v3/v5/v6 APIs with caller-provided short output buffers, not v4; installed jayson uses v4(). No demonstrated app exploit.
- **Action:** First patched release for older majors is 11.1.1; no patched 8.x/9.x release found. Do NOT globally override to 11: major/API/package export differences require consumer regression. Prefer narrow upstream compatible consumer fix/backport; retain safe existing root 11.1.1 and 14.0.3.

Representative exact installed dependency paths:

- `@circle-fin/modular-wallets-core@1.0.16` → `uuid@11.1.1` — not in captured vulnerable ranges; `node_modules/uuid/package.json`.
- `@circle-fin/app-kit@1.21.0` → `@circle-fin/unified-balance-kit@1.10.1` → `uuid@14.0.3` — not in captured vulnerable ranges; `node_modules/@circle-fin/unified-balance-kit/node_modules/uuid/package.json`.
- `@circle-fin/w3s-pw-web-sdk@1.1.11` → `uuid@9.0.1` — affected; `node_modules/@circle-fin/w3s-pw-web-sdk/node_modules/uuid/package.json`.
- `wagmi@2.19.5` → `@wagmi/connectors@6.2.0` → `@metamask/sdk@0.33.1` → `uuid@8.3.2` — affected; `node_modules/@metamask/sdk/node_modules/uuid/package.json`.

Every nested instance, exact direct-parent range and shortest root path is enumerated in `dependency-triage.json`; representative paths above are not an exhaustive list.

### zod

- Advisory IDs: [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (high)
- Exact resolved versions: 3.22.4, 3.25.67, 3.25.76, 4.6.6, 4.6.7
- Public Worker actually resolves/emits root 4.6.7 (patched); private Worker has no Zod. Browser transforms root 4.6.7 but emits no Zod; Reown 3.22.4 remains lock-only and was checked separately. Older transitive copies remain in approved SDKs. Bounded max(1) invalid-array check: v4.6.7 reports 1 issue vs v3.25.67 and v3.22.4 reporting 1001 for 1000 items, so older code cannot be dismissed as harmless name/range noise. Public readBody additionally caps streamed bytes at 256 KiB.
- **Action:** Keep root 4.6.7. GHSA first patched 4.6.6; registry has no patched 3.x backport. Do NOT force SDK zod 3 -> 4: major schema/API incompatibilities. Require upstream SDK compatible fix/backport or reviewed, bounded/non-reachable input disposition per consumer; root upgrade alone cannot clean the lock audit.

Representative exact installed dependency paths:

- `zod@4.6.7` — not in captured vulnerable ranges; `node_modules/zod/package.json`.
- `@circle-fin/adapter-viem-v2@1.20.1` → `zod@3.25.67` — affected; `node_modules/@circle-fin/adapter-viem-v2/node_modules/zod/package.json`.
- `@cloudflare/vitest-plugin@1.6.0` → `zod@4.6.6` — not in captured vulnerable ranges; `node_modules/@cloudflare/vitest-plugin/node_modules/zod/package.json`.
- `wagmi@2.19.5` → `@wagmi/connectors@6.2.0` → `@base-org/account@2.4.0` → `@coinbase/cdp-sdk@1.61.0` → `zod@3.25.76` — affected; `node_modules/@coinbase/cdp-sdk/node_modules/zod/package.json`.
- `wagmi@2.19.5` → `@wagmi/connectors@6.2.0` → `@walletconnect/ethereum-provider@2.21.1` → `@reown/appkit@1.7.8` → `@reown/appkit-wallet@1.7.8` → `zod@3.22.4` — affected; `node_modules/@reown/appkit-wallet/node_modules/zod/package.json`.

Every nested instance, exact direct-parent range and shortest root path is enumerated in `dependency-triage.json`; representative paths above are not an exhaustive list.

## Bounded installed-code checks

- Zod constrained invalid array (1,000 elements, max length 1): root 4.6.7 produces **1 issue**; Circle 3.25.67 and Reown 3.22.4 each produce **1,001 issues**. This verifies the relevant older-code resource amplification without an OOM test. It does not establish attacker input to an emitted app consumer.
- stream-json 1.9.1 Assembler accepts `__proto__` and replaces the result object prototype; a marker becomes inherited, not own. Global `Object.prototype` remains unchanged. This is a real installed-code concern even though no runtime bundle includes it.
- Scratch-only module substitution of core-utils esbuild to installed **0.25.12**: `transformSync` successfully strips a TypeScript annotation. No install/lock mutation; this is only a narrow compatibility signal.

## Evidence / reproducibility

- Worker bundles used `esbuild` **write:false + metafile**, ESM/browser/es2022, only `cloudflare:*`/`node:*` external. Browser build used matching React/node-polyfill/alias/dedupe settings, **write:false**, isolated empty envDir/cache/output/HOME; no project `.env` was read, no project `dist` overwritten. Final browser probe ran from repository cwd for normal Tailwind discovery.
- Full emitted per-chunk package inventory, parsed flagged-module records, Worker input/output byte records, installed paths, advisory ranges and upstream first-patched versions are retained in the JSON. Raw complete graphs/probe and bounded-check scripts are under `/home/deseti/.hermes/cache/scratch/retempo-dependency-triage` (scratch is prunable).
- Public unauthenticated GETs only to registry.npmjs.org and api.github.com/advisories; patch metadata URLs are in JSON. No npm auth, install, hosted accounts, Git or deploy actions. Registry latest is not automatically a compatible remediation.
- Scope limitation: package-name graph analysis is not an exhaustive certification of inline vendored SDK code. Empty build env is intentional; final approved production configuration and any changed source/lock require fresh graphs/full acceptance.
- Audit input hashes unchanged and equal parent metadata: `package.json 02ef91f0ec5e075b4550b2c82b02a4ef7537f6bb9037340095fc4b396d4f8efd`; `bun.lock 2df71760be28936457751a1f2f603686add23dfabbd9ad20b995e7e50f0e5db7`.

## Remaining release gates

- Do not report bun audit passing: captured exit 1 and all nine package findings remain unresolved in the lockfile.
- Review/approve precise compatible remediation or documented threat-boundary disposition; scoped same-major candidates grpc 1.13.6 and undici 6.29.1 require pinned-consumer compatibility checks. Esbuild scoped candidate 0.25.12 has only a small scratch transform smoke, not full migration acceptance.
- No compatible patch/minor fixes established for decode 0.2.x, elliptic, stream-json 1.x, toml 3.x, uuid 8/9 or zod 3. Do not use broad overrides/SDK removal to claim closure; obtain compatible upstream fix/backport or explicit reviewed bounded non-reachability disposition.
- After an approved minimal lock change, use isolated credential-free pinned Bun frozen install, rerun audit, regenerate runtime graphs and full source tests/build/signed acceptance. Current triage is not full-matrix acceptance.
- No production funded key may be passed through vulnerable elliptic signing. No untrusted Node stream/TOML/URI decode or older Zod input without bounded/trusted input review. Current Workers/browser absence is a scoped exposure result, not a license for future use.
- Parent must finish independent authorization/headers/runner fixes, final current-source matrix, provider CPU/quota/owner/deployment gates; this report does not close Phase 5.
