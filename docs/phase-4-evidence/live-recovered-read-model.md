# Recovered live billing read model

## Verified outcome

- `scripts/live-billing.test.ts`: 10 passing tests; `scripts/money-display.test.ts`: 5 passing tests. See `live-recovered-tests.log`.
- Root, Worker and legacy backend TypeScript checks all exited zero. See `live-recovered-typecheck.log`.
- Type-aware lint of the owned read-model, merchant pagination helper, dashboard pages, AreaChart and test exited zero. See `live-recovered-lint.log`.
- Vite production build exited zero. Dependency annotation and large-chunk warnings remain; see `live-recovered-build.log`.

## Implementation boundaries

The live service no longer spreads/imports the demo service. Overview, ledger, escrow and disputes read the authenticated organization snapshot. Lists exhaust the actual server's array-based `limit=100&offset=...` pagination. Legacy public invoice/checkout getters return null; legacy portal rejects in favor of the authenticated wallet portal.

The actual `chain-worker/src/projections.ts` was inspected: escrow projections expose pinned `balance`, `claimable`, `frozen`, `dispute`, `outcome`, `merchantResponded`, ISO dispute deadlines and vesting dates. Held, claimable and frozen balances use those exact fields, never current-time vesting approximations. Resolved dispute amounts use the verified opening event because the getter clears frozen funds after allocation. Missing funded snapshot state or malformed exact amounts fails closed.

Revenue counts manager payment events plus direct `EscrowFunded` events with `viaManager=false`, deduplicated by chain/transaction/log identity. Refunds use only `RefundCredited`; allocation events contribute merchant awards only. Wallet-wide `Withdrawn` never creates an organization payout without an independently scoped payout projection and its canonical withdrawal proof.

RevenueCard sums exact `baseUnits`, not dimensionless chart coordinates. Chart coordinates remain bounded; live labels retain exact USDC strings and the chart explicitly uses a relative percentage scale. No synthetic subscription history, growth badges, sample captions or demo notices remain on the owned financial pages. Contract-status request failures show unavailable rather than not deployed.

## RED → GREEN evidence observed during work

1. Missing pinned escrow/dispute mapper exports failed; implementation produced passing pinned balance/claimable/frozen assertions.
2. Live service overview returned demo `164650.00` instead of zero; removing demo fallback and wiring snapshot reads passed.
3. A 101-record invoice collection returned only 100; the offset-pagination helper passed the two-page test.
4. RevenueCard rendered `1,350` from chart coordinates instead of exact `3.234567`; exact BigInt summation passed server-render verification.
5. Financial-page source regression failed on obsolete sample/deployment captions; updated read-only descriptions passed.
6. An empty snapshot fabricated eight months of zero activity; honest empty historical activity passed.
7. A resolved dispute showed `0.00` from cleared frozen funds instead of opening `30.000001`; canonical opening-event amount passed.

## Remaining acceptance gaps / disclosures

- Tests exercise real mapping/service code and React server rendering; fetch is substituted only at the HTTP boundary. These tests are not independent receipt/D1, signed-wallet or browser integration acceptance. Those belong to the parent's isolated fixture/API/browser work.
- No authenticated browser screenshots/responsive interaction verification were performed in this bounded read-model task.
- Private indexer currently deliberately does not attribute wallet-wide withdrawals to organizations; payouts stay absent unless an independently scoped projection is supplied.
- Historical MRR/subscriber-growth analytics are intentionally omitted rather than invented.
- Existing customer mapper lifetime value remains zero; customer-level historical net revenue attribution is not implemented here. The unused legacy `toEscrowOverview` helper remains for preserved backend tests but is no longer imported by any live service.
- No onchain actions, SDK, customer UI, Worker/shared protocol, Solidity, account, deployment, Git publication or AGENTS edits were made by this task.
