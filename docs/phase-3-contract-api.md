# Phase 3 Approved Contract Policies and Integration Notes

The owner selected both policies below. These are local-source changes, not deployed mainnet features. See the verification report for final test status; do not infer completion from this API note.

## Renewed escrow dispute-term consent

`RetempoSubscriptionManager` records per-subscription response/resolution windows when an escrow subscription is created. Both manual `renew` and recurring `charge` reject before a debit, payment counter update, mandate spend or new escrow if the currently configured windows differ.

New interface:

- `acceptedEscrowTerms(bytes32 subKey)` returns `uint32 responseWindow, uint32 resolutionTimeout`.
- `acceptEscrowTerms(bytes32 subKey, uint32 expectedResponseWindow, uint32 expectedResolutionTimeout)` requires the active escrow subscription's customer, an unpaused manager, and exact equality between the submitted expected values and the current onchain values. A stale consent transaction reverts.
- `EscrowTermsAccepted(bytes32 indexed subKey, address indexed customer, uint32 responseWindow, uint32 resolutionTimeout)` records acceptance.
- `EscrowTermsNotAccepted()` is the rejection error; `canCharge` returns false with appended `ChargeReason` value **13**. Existing reason values 0–12 are not renumbered.
- When terms actually change, acceptance revokes an active recurring mandate. `MandateRevoked` reason **3** means changed escrow terms. Acceptance does **not** create a new mandate. The customer must separately authorize a new finite mandate before recurring billing resumes.
- Repeating acceptance of unchanged terms does not reset mandate spent, generation or active state. It may emit another acceptance event; never interpret that event as a reset of the billing budget.
- Direct-payment subscriptions are unaffected and cannot call the escrow-specific acceptance method. Missing/canceled subscriptions, third parties and paused acceptance fail closed.

The frontend must show the exact current windows and submit those values in acceptance. Handle a stale-window error by fetching and showing the changed terms again; never retry with new values silently. Display mandate revocation and require a separate explicit budget/expiry authorization. Existing funded escrows retain their snapshotted terms.

This consent commitment concerns the two future-escrow dispute windows. It is not an immutable commitment to every governance/issuer action, nor proof of an offchain user's understanding. Initial subscription creation records execution-time windows using the existing subscription ABI; this is not a transaction-quote guarantee against an intervening governance change before initial inclusion. Do not advertise that broader guarantee without a separately reviewed initial-quote commitment.

## Exclusive arbitration deadline

An assigned arbitrator may resolve only while `block.timestamp < disputedAt + resolutionTimeout`. At and after that exact timestamp, `resolveDispute` reverts with `ResolutionWindowEnded()` and leaves credits/frozen funds unchanged. `expireDispute` is permissionless from the deadline and applies the deterministic vested-at-open split.

Before the deadline, the existing response-window/merchant-response and arbitrator independence conditions still apply. Deadline passage itself does not send a transaction or automatically move funds: a party/keeper must call expiration. A first-transaction-wins race between a **late** arbitration and expiration is no longer accepted behavior.

## Blocklisted sender limits

Fresh localhost Arc Anvil acceptance established that a genuinely signed, zero-value transaction from the tested issuer-blocklisted EOA is rejected at native transaction admission, without nonce/balance changes. A clean relayer can submit a beneficiary-signed EIP-712 payout update and withdraw **already-existing** credit to an unblocked recipient.

Do not promise that a blocked EOA can still directly claim, refund or set a payout merely because an internal `vm.prank` call passes. Issuer-wide pause/blocklisting of escrow can still prevent everyone from withdrawing. These limitations are not an admin-controlled sweep or bypass of issuer policy.

## Release and application boundaries

No real contract addresses, Safe/signers, guardian, arbitrators, business caps or funded transaction approvals are supplied by test fixtures. Production deployments, independent security review, verified event ingestion, frontend wallet integration, email delivery and public release remain separate gates. Existing D1 financial-state guards stay fail-closed.
