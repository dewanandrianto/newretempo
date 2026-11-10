# RetempoEscrow: Design (v2, final decisions recorded)

Parent: [`RETEMPO-design.md`](./RETEMPO-design.md). Status: **approved for implementation with the owner's adjustments (D1, D3, D4, D5, D13, D14).** Implementation: `contracts/RetempoEscrow.sol`. Nothing is deployed.

## 1. Purpose and custody rule

Hold USDC for an invoice or subscription charge, release it by linear vesting, and protect the customer with refunds, partial disputes, an independent customer-accepted arbitrator, mutual settlement and a deterministic timeout. USDC leaves the contract only through `withdraw` / `withdrawToPayout`, only from one account's own `withdrawable` balance, which only grows through the accounting paths below. No role can debit or redirect it.

## 2. Types

```
enum Status      { None, Pending, Active, Closed, Cancelled }
enum DisputeState{ None, Open, Resolved }
enum Outcome     { None, FullyVested, Refunded, Resolved, Expired, Settled }

struct Escrow {
  address merchant; address customer; address arbitrator;
  uint128 amount;        // D  original deposit
  uint128 claimed;       // C  credited to merchant by vesting claims
  uint128 awarded;       // A  credited to merchant by resolution/settlement/expiry
  uint128 refunded;      // R  credited to customer
  uint128 frozen;        // X  amount currently disputed (held aside, still part of B)
  uint128 carvedVested;  // Xv part of X deemed already vested when the dispute opened
  uint40  vestStart; uint32 vestDuration;
  uint32  responseWindow; uint32 resolutionTimeout;   // snapshots of config at creation
  uint40  disputedAt;
  bool    customerMayRefundUnvested; bool merchantResponded;
  Status status; DisputeState dispute; Outcome outcome;
  // proposals (each cleared when applied or replaced)
  uint32 settlementId; address settlementProposer; uint128 settlementMerchantAmount;
  address replacementProposer; address replacementCandidate;
}
```

Global: `escrows`, `withdrawable[account]`, `payoutAddress[account]`, `totalLocked` (sum of escrow balances B), `totalWithdrawable`, `arbitrators` allowlist, config (`minAmount`, `maxEscrowAmount`, `maxAggregateExposure`, `responseWindow`, `resolutionTimeout`) applied only to **new** escrows (except the two limits, which gate new funding), `immutable usdc`, `immutable manager`. Constructed **paused**.

## 3. Formulas (integer base units, 6 decimals; no floating point; no `unchecked`)

`B = D - C - A - R` (held; includes the frozen part). `Free = B - X`.

- `vested(t) = 0` if `t <= vestStart`; `D` if `t >= vestStart + vestDuration`; else `floor(D * (t - vestStart) / vestDuration)` via `Math.mulDiv`.
- `vestedAdj(t) = vested(t) - Xv` (never negative: `Xv <= vested(disputedAt) - C`).
- Cap: `cap = D - R - A - X`.
- Entitlement: `E(t) = min(vestedAdj(t), cap)`. Merchant `claimable(t) = E(t) - C` while Active.
- Customer unvested refund (flag required): `Free - claimable(t)`. Afterwards `cap = C + claimable`, so vesting stops growing and the merchant keeps exactly what has vested.
- Merchant refund `r`: `0 < r <= Free`; `R += r`.
- **Partial dispute (D4)** with amount `X` (`0 < X <= B`, one dispute per escrow): `c0 = claimable(now)`; `Xv = min(X, c0)`; `frozen = X`; `carvedVested = Xv`. The disputed amount is taken from the already-vested, unclaimed funds first, so only `max(c0 - X, 0)` stays claimable now, and `Free` keeps vesting normally. Because `E` is continuous at open, undisputed vested funds are never frozen.
- Arbitrator ruling: `0 <= m <= X`; `A += m`; `R += X - m`; `frozen = 0`; `dispute = Resolved`. `E` does not change (cap and `vestedAdj` are unchanged), so the arbitrator can never touch more than `X`.
- Timeout split (after `disputedAt + resolutionTimeout`, anyone): `m = Xv`, customer gets `X - Xv`.
- Settlement scope: if a dispute is Open, `m <= X` and it resolves the dispute; otherwise `m <= B` and it closes the whole escrow. `A += m`, `R += scope - m`.
- Closed when `C + A + R == D` (needs `X == 0`).

**Rounding.** Floor division rounds vested down: the merchant is never credited more than exact pro rata, and the customer's unvested refund is higher by less than 1 base unit. At the end vested equals `D` exactly (no dust). Splitting payments into many escrows gains at most 1 unit each, and `minAmount` makes it uneconomical. All outflows are integer credits; claims, awards and refunds are separately tracked (`C`, `A`, `R`), so double claims or double refunds are impossible by construction (invariants in the parent doc).

## 4. Decisions recorded for this contract

| ID | Decision |
| --- | --- |
| D3 | All-pull ledger. A reverting or blocklisted recipient makes only that caller's `withdraw` revert; state and every other balance are untouched and the credit is preserved. `payoutAddress[account]` lets an account route its own withdrawals elsewhere. Updates require the account itself (direct call) or an EIP-712 signature by the account (EOA, or EIP-1271 smart wallet) with a per-account nonce and deadline. No admin function touches `withdrawable` or `payoutAddress`. |
| D4 | Partial freeze as in section 3. |
| D5 | The merchant **proposes** one allowlisted arbitrator at creation. The customer must call `fund(key, acceptedArbitrator, termsHash)`, which reverts unless it names exactly that arbitrator and the terms hash matches; emits `ArbitratorAccepted`. Selection rules: allowlisted, not zero, not the merchant or customer, holds no admin/config/pauser/arbitrator-manager role. Replacement: only by mutual consent (`proposeArbitratorReplacement` by one party, `acceptArbitratorReplacement` by the other naming the same candidate), candidate subject to the same rules, allowed in any Active escrow including during a dispute. Conflict rules are re-checked at ruling time: the arbitrator must still be allowlisted and unconflicted, otherwise the timeout split or a replacement applies. Plan-routed escrows: the customer accepts the plan arbitrator when subscribing (manager doc). |
| D13 | Constructed paused. `maxEscrowAmount` initial 10,000 USDC per escrow (hard ceiling 1e15), `maxAggregateExposure = totalLocked + totalWithdrawable` set at construction, `minAmount` 0.01 USDC. All limits are changed only by `CONFIG_ROLE` (multisig), are bounded, and emit `ParameterUpdated(key, old, new)`. Lowering a limit never touches existing funds. |
| D6/D7/D18 | Windows default 7 days (bounds 1 to 30) and 30 days (bounds 7 to 90). Unvested refund only if the merchant set the flag. Minimum 0.01 USDC. |

## 5. Functions

"Paused": Y if allowed while paused. All have custom errors; external-call functions are `nonReentrant`; order is checks, effects, events, then the single token call.

| Function | Caller | Effect | Paused |
| --- | --- | --- | --- |
| `createEscrow(invoiceRef, customer, amount, vestDuration, proposedArbitrator, refundable)` | merchant | Pending; key `keccak(abi.encode(merchant, invoiceRef))`; snapshot terms | N |
| `cancelUnfunded(key)` | merchant | Pending to Cancelled | Y |
| `fund(key, acceptedArbitrator, termsHash)` | customer only | pull `amount`, delta check, `vestStart = now`, Active, exposure and per-escrow limits | N |
| `fundFromManager(invoiceRef, merchant, customer, amount, vestDuration, arbitrator, refundable)` | `manager` only | create + fund atomically from the manager's balance | N |
| `claim(key)` | merchant | credit `claimable(now)` | Y |
| `merchantRefund(key, amount)` | merchant | credit customer up to `Free` | Y |
| `customerRefundUnvested(key)` | customer | flag required; credit `Free - claimable` | Y |
| `openDispute(key, amount, reasonHash)` | customer | partial freeze | Y |
| `respondToDispute(key, responseHash)` | merchant | within `responseWindow` | Y |
| `resolveDispute(key, merchantAmount, rulingHash)` | assigned arbitrator | after response or window; `m <= X` | Y |
| `expireDispute(key)` | anyone | timeout split | Y |
| `proposeSettlement(key, merchantAmount)` / `acceptSettlement(key, merchantAmount, id)` | either party / the other | scope rule above | Y |
| `proposeArbitratorReplacement(key, candidate)` / `acceptArbitratorReplacement(key, candidate)` | either party / the other | replace arbitrator | Y |
| `withdraw(to)` | account | send own balance to `to` | Y |
| `withdrawToPayout(account)` | anyone | send `account`'s balance to its registered payout address (or itself) | Y |
| `setPayoutAddress(newPayout)` / `setPayoutAddressBySig(account, newPayout, deadline, signature)` | account / relayer | update own payout address | Y |
| `pause()` / `unpause()` | `PAUSER_ROLE` / admin | toggle | n/a |
| `setMinAmount`, `setMaxEscrowAmount`, `setMaxAggregateExposure`, `setResponseWindow`, `setResolutionTimeout` | `CONFIG_ROLE` | bounded, future-only | Y |
| `addArbitrator(a)` / `removeArbitrator(a)` | `ARBITRATOR_MANAGER_ROLE` | allowlist | Y |

## 6. Events (backend contract)

`escrowKey` is the first indexed topic. `EscrowCreated(escrowKey, merchant, customer | invoiceRef, amount, vestDuration, arbitrator, refundable, responseWindow, resolutionTimeout)`, `ArbitratorAccepted(escrowKey, customer, arbitrator | viaManager)`, `EscrowFunded(escrowKey, payer | amount, vestStart, vestEnd, viaManager)`, `EscrowCancelled(escrowKey)`, `VestedClaimed(escrowKey, merchant | amount, totalClaimed)`, `RefundCredited(escrowKey, customer | amount, reason, totalRefunded)`, `DisputeOpened(escrowKey, customer, arbitrator | amount, carvedVested, reasonHash, respondBy, resolveBy)`, `DisputeResponded(escrowKey, merchant | responseHash)`, `DisputeResolved(escrowKey, arbitrator | merchantAmount, customerAmount, rulingHash)`, `DisputeExpired(escrowKey, caller | merchantAmount, customerAmount)`, `SettlementProposed(escrowKey, proposer | merchantAmount, settlementId)`, `SettlementAccepted(escrowKey, acceptor | merchantAmount, customerAmount, settlementId, disputeScoped)`, `ArbitratorReplacementProposed(escrowKey, proposer, candidate)`, `ArbitratorReplaced(escrowKey, oldArbitrator, newArbitrator)`, `EscrowClosed(escrowKey | outcome)`, `Withdrawn(account, to | amount)`, `PayoutAddressUpdated(account, newPayout | nonce)`, `ArbitratorAdded/Removed(arbitrator)`, `ParameterUpdated(key | oldValue, newValue)`, plus OpenZeppelin `Paused`, `Unpaused`, `RoleGranted`, `RoleRevoked`, `RoleAdminChanged`, `DefaultAdminTransferScheduled/Canceled`, `DefaultAdminDelayChangeScheduled/Canceled`.

## 7. Why admins cannot reach funds

No function lets any role move, sweep, confiscate or reassign USDC, change a live escrow's terms or amounts, or alter an account's payout address. Admin power is limited to roles, the pause flag, the arbitrator allowlist and bounded parameters that only affect new items. Removing an arbitrator moves no money; affected disputes use the timeout split or a mutual replacement. Accidentally or forcibly sent USDC is unrecoverable by design (no sweep).

## 8. Worked example (partial dispute)

90 USDC, 30-day vesting. At day 12, vested 36, claimed 30, so `c0 = 6`, `B = 60`. Customer disputes `X = 20`: `Xv = min(20, 6) = 6`, so the merchant can claim `0` right now (`E = min(36 - 6, 90 - 20) = 30 = C`) but `Free = 40` keeps vesting: at day 30 vested adj is `90 - 6 = 84`, cap `70`, so the merchant can claim `70 - 30 = 40` while 20 stays frozen. The arbitrator awards 8 to the merchant and 12 to the customer: `A = 8`, `R = 12`, escrow Closed (`30 + 40 + 8 + 12 = 90`).

## 9. Tests specific to this contract

Every function (success and each revert), vesting boundaries, rounding fuzz, random operation sequences (claim, refund, dispute, rule, settle, expire, withdraw), arbitrator conflict and replacement matrix, payout-address signature (EOA, EIP-1271, bad signer, wrong nonce, expired deadline), blocklist mock (one account's `withdraw` reverts while others succeed and the credit survives), malicious-token reentrancy and fee-on-transfer, pause matrix, unauthorized-caller matrix, limit changes with events, and invariants I1 to I4 and I8.
