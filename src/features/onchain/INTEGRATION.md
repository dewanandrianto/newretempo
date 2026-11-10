# Frontend wallet integration API (Phase 4)

Owned implementation: `src/services/blockchain/`, `src/features/onchain/`, `src/features/customer/`, `src/components/wallet/WalletButton.tsx`, `src/config.ts`. No contract, global registry, root package, Worker, or router changes.

## Parent integration

Import from `@/services/blockchain`:

- `chainApi.configuration()`, `organizationSnapshot(orgId)`, `customerSnapshot()`, `sync()`.
- `chainApi.preparePlan(orgId, planId, { wallet, payout, arbitrator, customerMayRefundUnvested, graceSeconds? })` returns `ChainPlanPreparation`.
- `chainApi.createCheckout(orgId, { subscriptionId, invoiceId?, expiresInSeconds? })` returns an actual private capability `{ token, url, checkout }`. Never substitute invoice UUIDs for capabilities.
- `chainApi.checkout(token, invoice?)` and `prepareCheckout(token, wallet)` use the shared public API.
- `createRetempoClient(configuration, walletClient)` creates the wallet SDK. Reads use only the configured public read RPC. Wallet proof requests use the actual provider transport, not Wagmi's default RPC.
- `displayUsdc(baseUnits)`, `parseUsdc(decimalInput)` and `baseUnits(canonicalWireString)` preserve integer precision.

`useRetempoTransactions(configuration, operationKey, snapshotLoader?)` returns `{ state, busy, error, execute, sync, resume, signIn, verifiedWallet, client }`.

```tsx
const readSnapshot = () => chainApi.organizationSnapshot(orgId)
const tx = useRetempoTransactions(configuration, `publish:${prepared.planId}`, readSnapshot)
await tx.execute((sdk, write) => sdk.publishPlan(prepared, write))
await tx.sync({ kind: 'plan', key: prepared.planKey, states: ['active'], eventNames: ['PlanCreated'] })
```

`ContractAction` wraps this behavior as a reusable button/status component. Required props: `configuration`, `operationKey`, `label`, `action(sdk, write)`, `target`. Optional: `snapshot` (merchant MUST provide their organization snapshot), `disabled`, `variant`, `children`. It automatically requests verified synchronization after execution. Never pass raw capability tokens as `operationKey`; use stable public record IDs and charge count/mandate nonce to distinguish separate intentional operations.

`TransactionStatus` renders wallet prompts, approval/pending receipt, rejection, revert, uncertain submission, confirmed-but-not-indexed and verified backend results. A receipt alone is not success. `resume()` checks the original receipt. `sync(target)` does nothing unless an original payment/action receipt is confirmed; it never submits a wallet write.

## SDK action parameters

Every method below returns `Promise<void>` and accepts the runner-provided `write` as its final argument (except the specifically documented read methods). Hashes are `0x` bytes32 values. Currency strings are canonical six-decimal **base-unit integers**, never formatted decimals. No action takes an ETH/native `value`.

- `publishPlan(preparation, write)`
- `subscribe(preparedCheckout, displayedWindows, write)`
- `renew(subscriptionKey, displayedCheckoutTerms, displayedWindows, write)`
- `cancelSubscription(subscriptionKey, write)`
- `createMandate(subscriptionKey, { perChargeCap, totalCap, expiry /* Unix seconds, exclusive */ }, displayedCheckoutTerms, displayedWindows, write)`
- `revokeMandate(subscriptionKey, write)`
- `acceptEscrowTerms(subscriptionKey, { responseWindow, resolutionTimeout } /* exact reviewed seconds */, write)` — changing acceptance revokes an existing mandate in the contract; UI requires a separate new finite mandate.
- `claim(escrowKey, write)`
- `refundUnvested(escrowKey, write)`
- `merchantRefund(escrowKey, amount, write)`
- `openDispute(escrowKey, amount, reasonHash, write)`
- `respondToDispute(escrowKey, responseHash, write)`
- `resolveDispute(escrowKey, merchantAmount, rulingHash, write)`
- `expireDispute(escrowKey, write)`
- `withdraw(destination, write)`
- `withdrawToPayout(account, write)` — permissionless contract route to the owner's existing payout.
- `setPayoutAddress(destination, write)`
- `setPayoutAddressBySig(account, destination, deadlineBigInt, signatureHex, write)` — actual ABI-supported authorization submission; no hosted relay or automatic signing is claimed.
- `setPlanPayout(planKey, destination, write)`

Read methods: `assertWallet()`, `getPlan(key)`, `getSubscription(key)`, `getMandate(key)`, `getEscrow(key)`, `windows()`, `acceptedEscrowTerms(key)`, `canCharge(key)`, `balance()`, `timestamp()`, and `read<T>(target, ABI-function-name, args?)`. `canCharge` reason 13 means changed escrow windows need explicit renewed acceptance; accepting them alone never creates a mandate.

The SDK verifies the wallet/reader/configured genesis and both manager/escrow bytecode hashes before signing or writing, validates deployment links and USDC decimals, compares displayed plan terms before payment/budget approval, approves only the exact payment or explicitly entered finite budget, simulates calls, and waits for real receipts. Approval replaces the manager-wide token allowance; that allowance is shared between subscriptions. Native gas uses 18 decimals; ERC-20 contract amounts use 6.

## API dependencies / parent integration findings

1. Public API currently returns `/checkout/:token` from `createCheckout`, while the existing root router has `/pay/:sessionId`. Parent owns router: add an alias or coordinate returned URL. This child intentionally does not edit it.
2. Subscription-backed invoices are enabled; standalone invoice payment is not supported by the public API. Backend correctly rejects unsupported invoice amounts. No manual invoice is falsely paid or silently rerouted.
3. Portal renewal is enabled only when a stable next-charge payment binding exists. Otherwise it explains that the merchant must prepare the next invoice/capability. The API preparation route registers the exact charge before payment.
4. Wallet-level `Withdrawn` / `PayoutAddressUpdated` proof uses the coordinated owner-authorized `walletSnapshot(wallet)` endpoint (`kind: 'wallet'`, `recordId: lowercase account`, `state: 'updated'`, exact event tx hash). Missing or unavailable projection remains indexing-pending; a receipt is never substituted for backend verification.
5. Frozen existing contracts cannot atomically enforce mutable plan payout/window terms in `subscribe` calldata. The SDK rechecks immediately before approvals and action submission; onchain acceptance guards and final simulation remain authoritative. No stronger guarantee is claimed.
6. The earlier root frontend TypeScript blocker in `scripts/live-billing.test.ts` was resolved by its owner; root and scoped TypeScript both pass during recovery verification.

## Merchant action glue and browser selectors

- `MerchantActions.tsx`: `PublishPlanAction({ plan })`, `CheckoutLinkAction({ subscriptionId, invoiceId? })`, `MerchantSubscriptionAction({ subscriptionId })`. Plans and subscriptions pages now mount these controls; HTTP-only cancellation has been removed from the live subscription action.
- Publish flow: click **Publish onchain**, connect wallet, **Verify merchant wallet** if needed, fill **Payout address** and (escrow only) **Arbitrator address**, optionally **Allow customer unvested refunds**, then **Prepare plan publication**. Preparation uses the authenticated server binding before a write. Review the returned immutable terms, check **I reviewed these exact immutable plan terms.**, then **Publish plan onchain**. Dialog content has `data-testid="publish-plan-${plan.id}"`.
- Subscription flow: click **Checkout link**, then **Create 24-hour checkout link**; read the **Private checkout URL** input or **Open checkout** link. The URL comes from the server capability, never a subscription/invoice UUID. **Cancel onchain** opens a consent dialog followed by **Confirm onchain cancellation** and the actual SDK write.
- Parent invoice insertion (MoneyPages owner): import `CheckoutLinkAction` from `@/features/onchain/MerchantActions`; render `<CheckoutLinkAction subscriptionId={invoice.subscriptionId} invoiceId={invoice.id} />` only for a subscription-backed open invoice. Standalone invoices remain unsupported and must not be routed to another amount.
- Parent escrow insertion (EscrowPage owner): import `MerchantEscrowControls` from `@/features/onchain/MerchantEscrowControls`; render `<MerchantEscrowControls />` once, or pass `escrowId` to filter a detail view. It loads the authenticated organization's bindings and exposes permitted claim, exact merchant refund, response commitment, arbitrator resolution, expiration, and wallet credit/payout controls. Each escrow section has `data-testid="merchant-escrow-${recordId}"`. Contract simulation remains authoritative when timing/balance changes.
- `chainApi.walletSnapshot(wallet)` reads `/api/wallet/chain/snapshot?wallet=...`. `CreditCard` uses this wallet-owned loader specifically for withdrawal/payout proof and lowercases the target record ID. It does not attribute a merchant wallet's aggregate withdrawals to an organization.
- Transaction journals now retain a public `verification` target before wallet submission. Checkout persists its prepared payment ID, so reload followed by **Retry verification** can verify the original payment without another prepare or wallet write. No capability token is journaled.
- Checks during recovery: root frontend TypeScript and scoped onchain TypeScript passed; scoped production type-aware lint passed; **28 onchain unit/fixture tests passed**. Production bundle built successfully with existing third-party annotation/oversized-chunk warnings. Existing public browser regression: **7 passed** at 320/360/390/768/1440 and invalid invoice/disabled portal. These browser tests are explicit HTTP fixtures; signed local Arc + two-Worker merchant/customer acceptance remains the parent's separate gate.

## Verification scope

`tests/onchain/vitest.config.ts` is Worker-independent. Tests use explicit local wallet/RPC/HTTP fixtures, not real settlement. `tests/onchain/public.browser.test.mjs` verifies disabled public checkout at 320/360/390/768/1440, invalid capability invoice, and disabled portal against an actual Vite production bundle. This does NOT claim signed local-Arc or full authenticated UI end-to-end acceptance; the parent owns that harness.

Commands:

```sh
node node_modules/vitest/vitest.mjs run --config tests/onchain/vitest.config.ts
node node_modules/typescript/bin/tsc --noEmit -p tests/onchain/tsconfig.json
node node_modules/.bin/oxlint --type-aware src/services/blockchain src/features/onchain src/features/customer src/components/wallet src/config.ts tests/onchain
node --test tests/onchain/public.browser.test.mjs
```

Browser fixtures require an already-running preview at `RETEMPO_PREVIEW_URL` (default `http://127.0.0.1:4319`). The isolated existing Playwright installation is used; no new package dependencies were added. Browser evidence goes to `RETEMPO_BROWSER_EVIDENCE_DIR` or the scratch path specified in the test.
