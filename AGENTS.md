# RETEMPO

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

RETEMPO is a Web3 subscription billing platform for SaaS (USDC on Arc), with subscription-manager and vesting-escrow Solidity implementations. Local delivery Phases 1 and 2 are verified; see `docs/phase-1-baseline.md` and `docs/phase-2-verification.md`. The `arc-testnet-beta` branch is deployed to Arc Testnet with a private read-only chain worker; both contracts remain paused and all financial actions remain disabled. This is testnet-only, not production or mainnet. Do not unpause, enable financial activity, or deploy to mainnet without explicit user approval. Historical Arc Studio phase labels are not the current delivery plan.

The default API is `worker/src/index.ts`; `bun run api` runs Wrangler locally on port 8787 with static assets. `bun run db:migrate` applies only local D1 migrations. `bun run test` runs real workerd/D1 tests. The preserved legacy Bun/PostgreSQL reference lives in `backend/` and `database/`, with `api:legacy`, `db:legacy:migrate`, and `test:legacy` commands. Never print `.env`/`.dev.vars` values or use an existing database for destructive tests. No existing PostgreSQL data was imported or deleted.

Rules that must hold: no deployment or funded transaction without explicit approval, no fake payment confirmation, no invented addresses, and no secret output. The approved target for this beta is Arc Testnet; mainnet is out of scope. Local tests remain mandatory. Frontend wallet defaults and public deployment remain testnet-only. D1 authoritative financial writes are entirely disabled pending a reviewed verified-event writer/migration. Do not replace PostgreSQL transaction-local authority with a shared writable D1 flag. Money is canonical integer TEXT in D1, BigInt in code, strings in JSON; never route it through JS numbers. Business-facing UI uses live account records and verified chain data only; when no data exists, show an empty state instead of mock records. All merchant routes use `requireWorkerOrg()` for tenant/RBAC checks. SIWE is EOA-only (no EIP-1271).

Preserve the global/default GitHub login `deseti`. Retempo's intended account is `dewannadrianto`, with project-scoped authentication and commit identity to be configured only with approval. Do not run `git add`, `git commit`, or `git push`, alter remotes, change authentication, deploy, or enable paid services without explicit authorization. Keep all project code comments, UI, and documentation in English.

Keep the Workers runtime free of Bun/PostgreSQL runtime imports. Use Drizzle for typed queries and D1 prepared atomic batches for multi-statement writes with audits. Preserve tenant composite keys, exact amounts, idempotency, last-owner and financial guards. Never reduce MVP scope silently or claim that mock-token tests prove Arc runtime compatibility. Production email requires a real MAILER service binding; test adapters cannot be presented as delivered email. Strong password hashing and free-tier CPU limits require production validation, not weakened work factors.

Deployed contracts (Arc Testnet, chain ID 5042002; both paused): `RetempoEscrow` `0x0b862d1E56fD6303e303C55e7337961DF479E747`; `RetempoSubscriptionManager` `0x83426CFF6bEf85058eBb7f20FcED0a9965e73e25`.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, Privy React SDK and Privy wagmi adapter
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, tests in `contracts/test/`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (isolated local Forge wrapper). Compile cache isolation alone does not isolate persisted invariant counterexamples. Keep the configured run/depth limits and all invariant/coverage assertions intact.
- Wallet: Privy-managed embedded wallets; external wallets are selected inside the Privy sign-in flow. Keep the injected connector only for legacy SIWE recovery when Privy is disabled.
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Testnet)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Router + AuthProvider composition
- `src/app/router.tsx` - All routes (/, /login, /signup, /onboarding, /app/*, /pay/:id, /portal, /invoice/:id)
- `src/components/ui|charts|layout|wallet` - design system and shells
- `src/features/*` - landing, auth, dashboard pages, customer pages
- `src/services/*` - api client, auth (server), live billing, merchant API, blockchain
- `worker/` - current Workers API, Drizzle schema, D1 migrations and real workerd tests
- `backend/` - preserved legacy reference; `backend/tests` - `bun run test:legacy`
- `shared/types` - domain types (alias `@shared`)
- `database/migrations` - existing PostgreSQL schema; `contracts/` - manager/escrow implementations, interfaces, and tests
- `src/config.ts` - wagmi config (chains, connectors, transports)

## Share links

- Starter apps already ship `getShareBase`, `buildShareLink` and `installShareSync` in `src/lib/share.ts`; import them instead of rewriting them.
- Keep shareable state in the URL path or query, not in the `#fragment`.
- Never put a secret (private key, claim secret, seed phrase, session token, API key) in the URL path or query, encoded or not: every in-app path and query is mirrored to the visitor's studio.arc.io address bar and browser history and reaches servers. A bearer claim secret goes only in the `#fragment` appended to the share link (`` `${await buildShareLink('/claim')}#${secret}` ``) and is read from `location.hash` on load. A link to the app's own share URL shown inside the app must be copy-only or open in a new tab with `target="_blank" rel="noopener noreferrer"`.
- Build every link a user copies or sends with `buildShareLink()` from `src/lib/share.ts`.
- Keep the `installShareSync()` call in `src/main.tsx` when editing it; it keeps the Studio address bar in step with in-app navigation.
- Navigate inside the app with relative links.

## To Run

```bash
bun install
bun run dev
```
