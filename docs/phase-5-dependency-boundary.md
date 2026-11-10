# Phase 5 Dependency Boundary

This is a scoped local-readiness disposition, not a clean dependency audit, vulnerability waiver, third-party audit or production deployment approval.

## Observations

- The credential-isolated pinned Bun audit returned **exit 1**: nine package names and 37 advisory records remain in the lockfile. Preserve `dependency-audit.json`, `dependency-audit-metadata.json` and `dependency-triage.{json,md}` under `docs/phase-5-evidence/`.
- The triage inspected exact installed versions/consumer constraints and fresh write-free Worker/browser bundle graphs, including deferred browser chunks. No affected flagged package was emitted in those inspected outputs. The public Worker emits patched root Zod 4.6.7; workerd native fetch is not the affected Firebase npm Undici transport.
- This is package-graph evidence, not proof that all third-party vendored/inlined code is free of vulnerabilities. Parsed imports and all root dependencies are not equivalent to deployed executable exposure.
- No dependency was removed or upgraded merely to make the advisory count disappear. Broad major overrides would risk breaking approved SDK behavior and would not be justified by the captured tests.

## Local disposition and restrictions

Keep the existing lockfile for this release candidate while completing the reviewed application fixes and full regression matrix. Do not label `bun audit` as passing. Record the audit failure separately from the application's measured runtime exposure.

Do not use the affected Node/Firebase/Anchor/stream-parser/older-schema branches with untrusted input or funded production keys. In particular, do not use the legacy `deploy:self` or `compass:deploy` helpers as an approved production deployment path. Their presence in package.json is neither launch authorization nor a security disposition for their transitive dependencies. Retaining approved Circle SDK dependencies does not authorize executing every SDK branch.

The planned release path is the separately reviewed Worker packaging/configuration and frozen Arc contract toolchain, not an unreviewed SDK signing/deployment fallback. The currently used root Miniflare/Undici and root/Vite esbuild instances were outside the captured affected ranges; this does not certify future versions or every dev-tool entry point.

## Gates for any changed boundary

1. Before introducing a previously unused SDK, connector, Node parser, signing path, server, or input source, assess its exact flagged branch. Obtain a compatible upstream fix/backport or a specifically reviewed bounded non-reachability/input disposition; do not silently inherit this document as blanket approval.
2. Any approved dependency/configuration/source change requires a fresh advisory capture, emitted-runtime graph review and full applicable tests/build/signed integration. The current graph's fingerprint is not evidence for changed packages or newly reachable code.
3. Same-major candidates grpc 1.13.6 and selected Firebase Undici 6.29.1 still require consumer compatibility tests; the scoped esbuild 0.25.12 candidate has only a narrow scratch transform smoke. None was installed here. Do not downgrade safe existing root copies or force incompatible ESM/major versions into CommonJS consumers.
4. Keep the separate production CPU/quota, account/resource/custody, mainnet exposure and appropriate independent audit gates. A scoped module-graph disposition satisfies neither those gates nor remote ownership verification.

The user has not authorized Git publication, deployment, paid infrastructure or funded mainnet transactions through this disposition.
