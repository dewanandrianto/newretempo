# RetempoSubscriptionManager: Design (v2, final decisions recorded)

Parent: [`RETEMPO-design.md`](./RETEMPO-design.md). Sibling: [`RetempoEscrow-design.md`](./RetempoEscrow-design.md). This doc owns the plan, subscription and mandate slice. Status: **approved for implementation with the owner's adjustments (D1, D3, D5, D8, D13).** Implementation: `contracts/RetempoSubscriptionManager.sol`. Nothing is deployed.

## 1. Purpose

Let merchants publish plans, let customers subscribe and renew by hand, and let customers authorize capped, expiring recurring charges that **anyone** may trigger. The contract itself re-checks every authorization rule at charge time. It holds no USDC at rest: each payment flows customer to merchant payout, or customer to manager to `RetempoEscrow` in one transaction.

## 2. Types and storage

```
enum SubStatus { None, Active, Canceled }

struct Plan {
  address merchant;
  address payout;               // where direct payments go (merchant may change)
  uint128 amount;               // price per period, immutable (new price = new plan)
  uint32  interval;             // seconds, [1 day, 366 days]
  uint32  trial;                // seconds before first charge, 0 = charge on subscribe
  uint32  grace;                // seconds, must be < interval
  uint32  vestDuration;         // 0 = pay merchant directly; else escrow vesting seconds
  address arbitrator;           // escrow terms, used when vestDuration > 0
  bool    customerMayRefundUnvested;
  bool    active;               // false blocks NEW subscriptions only
}

struct Subscription {
  address customer;
  bytes32 planKey;
  uint128 amount;               // price snapshot at subscribe
  uint32  interval;             // snapshot
  uint32  grace;                // snapshot
  uint40  nextChargeAt;
  uint32  chargeCount;
  address acceptedArbitrator;   // customer's explicit acceptance of the plan arbitrator (D5); zero for direct plans
  SubStatus status;
}

struct Mandate {
  uint128 perChargeCap;
  uint128 totalCap;             // cumulative, finite
  uint128 spent;                // counts recurring charges only
  uint40  expiry;               // <= now + 366 days at creation
  uint32  nonce;                // increments on each new mandate
  bool    active;               // false after revoke/cancel
}
```

Storage: `mapping(bytes32 => Plan) plans`, `mapping(bytes32 => Subscription) subscriptions`, `mapping(bytes32 => Mandate) mandates` (one per subscription), `immutable usdc`, `immutable escrow`, config `maxPaymentAmount` (initial **10,000 USDC**, hard ceiling 1e15, D13), constants `MIN_PAYMENT = 10_000` (0.01 USDC) and `MAX_MANDATE_DURATION = 366 days`. Constructed **paused**. The constructor requires `escrow.manager() == address(this)` and `escrow.usdc() == usdc` (fail-closed linkage), a nonzero pauser that differs from the admin, and nonzero config account.

Keys (backend can compute them first): `planKey = keccak256(abi.encode(merchant, externalRef))`, `subKey = keccak256(abi.encode(customer, externalRef))`. `externalRef` must be nonzero.

## 3. Billing rules

- A subscription is charged for one period at a time. `nextChargeAt` is the first moment the next period may be paid.
- A charge (manual or recurring) is allowed only when `block.timestamp >= nextChargeAt`.
- After a successful charge at time `t`: if `t <= nextChargeAt + grace` then `nextChargeAt += interval` (cadence preserved, no drift), else `nextChargeAt = t + interval` (re-base: nobody is billed for time they were not served, D10). Because `grace < interval`, the new `nextChargeAt` is strictly greater than `t` in both branches, so a period can never be charged twice (invariant I7). Manual renewal and recurring charge share the same counter, so they cannot double bill each other.
- Trial: with `trial > 0`, `subscribe` charges nothing and sets `nextChargeAt = now + trial`; otherwise it charges the first period immediately (manual payment by the customer) and sets `nextChargeAt = now + interval`.
- Charge amount is always the subscription's snapshot `amount`. Merchants cannot raise the price on existing subscribers.
- Fixed seconds: "month" is 30 days and "year" is 365 days (D9). The UI must show this.

## 4. Mandate rules

A recurring `charge` requires **all** of the following, in this order, each with its own typed error:

1. subscription is Active, the plan exists, the amount is within `maxPaymentAmount`, and for escrow plans the customer-accepted arbitrator still equals the plan arbitrator;
2. `now >= nextChargeAt`;
3. mandate exists, `active`, and `now < expiry`;
4. `amount <= perChargeCap`;
5. `spent + amount <= totalCap`;
6. `usdc.allowance(customer, manager) >= amount`;
7. `usdc.balanceOf(customer) >= amount`.

Then (CEI): update `nextChargeAt`, `chargeCount`, `spent`, emit, and only then move USDC. A mandate is never unlimited: creation requires `perChargeCap >= sub.amount`, `totalCap >= perChargeCap`, `totalCap <= 1e15`, `expiry` in the future and at most 366 days away. Manual `renew` by the customer does not consume the mandate cap because the customer is authorizing that payment directly in the same transaction. Revocation is instant, always allowed (also while paused), and replacing a mandate bumps `nonce` and resets `spent`. The customer should approve only the mandate's total cap to USDC; the app will show this.

`canCharge(subKey)` returns a reason code (0 ok, or the first failing check) so bots avoid reverting transactions.

## 5. Functions

| Function | Caller | Effects | Events | Reverts | Paused |
| --- | --- | --- | --- | --- | --- |
| `createPlan(externalRef, payout, amount, interval, trial, grace, vestDuration, arbitrator, refundable)` | merchant | stores plan, active | `PlanCreated` | exists, zero ref/payout, amount below `MIN_PAYMENT` or above `maxPaymentAmount`, interval out of range, grace >= interval, vestDuration invalid (0 or 1h to 90d), arbitrator not allowlisted in escrow when vesting | N |
| `setPlanActive(planKey, active)` | plan merchant | toggles; activating needs not paused | `PlanUpdated` | not merchant | deactivate Y, activate N |
| `setPlanPayout(planKey, payout)` | plan merchant | updates payout | `PlanUpdated` | zero address, not merchant | Y |
| `subscribe(externalRef, planKey, acceptedArbitrator)` | customer | creates Active subscription; charges first period unless trial. For escrow plans `acceptedArbitrator` must equal the plan arbitrator (explicit acceptance, D5); for direct plans it must be zero | `SubscriptionCreated`, `SubscriptionPaymentProcessed` | exists, plan missing or inactive, customer == merchant, arbitrator not accepted, amount above `maxPaymentAmount`, and charge failures | N |
| `renew(subKey)` | subscription customer | manual charge when due | `SubscriptionPaymentProcessed` | not customer, not due, not Active, allowance/balance | N |
| `charge(subKey)` | anyone | recurring charge under mandate | `SubscriptionPaymentProcessed` | any section 4 check | N |
| `createMandate(subKey, perChargeCap, totalCap, expiry)` | customer | stores mandate, `nonce++` | `MandateCreated` (and `MandateRevoked` for a replaced one) | bounds in section 4 | N |
| `revokeMandate(subKey)` | customer | `active = false` | `MandateRevoked` | not customer, none active | Y |
| `cancelSubscription(subKey)` | customer or plan merchant | Canceled; mandate deactivated | `SubscriptionCanceled`, `MandateRevoked` | not party, already canceled | Y |
| `pause()` / `unpause()` / `setMaxPaymentAmount(v)` | Pauser / Admin / Config (multisig) | toggle / bounded limit | OZ + `ParameterUpdated(key, old, new)` | role, bounds | n/a |

Payment execution (internal, `nonReentrant`):

```
state updates and events first
if plan.vestDuration == 0:
    usdc.safeTransferFrom(customer, plan.payout, amount)
else:
    before = usdc.balanceOf(this)
    usdc.safeTransferFrom(customer, this, amount)
    require(usdc.balanceOf(this) - before == amount)
    usdc.forceApprove(escrow, amount)
    escrow.fundFromManager(invoiceRef = keccak(subKey, chargeCount), merchant, customer, amount, vestDuration, arbitrator, refundable)
    require(usdc.allowance(this, escrow) == 0 && usdc.balanceOf(this) == before)
```

Cancelling does not refund the current paid period; refunds are an escrow concern (vesting plans) or a merchant decision.

## 6. Events

| Event | Indexed | Data |
| --- | --- | --- |
| `PlanCreated` | planKey, merchant, externalRef | payout, amount, interval, trial, grace, vestDuration, arbitrator, refundable |
| `PlanUpdated` | planKey | active, payout |
| `SubscriptionCreated` | subKey, planKey, customer | externalRef, amount, interval, nextChargeAt, acceptedArbitrator |
| `SubscriptionPaymentProcessed` | subKey, planKey, customer | chargeNumber, merchant, amount, trigger (0 manual, 1 recurring), escrowKey (zero if direct), periodStart, nextChargeAt, rebased |
| `SubscriptionCanceled` | subKey, customer | by (customer or merchant address) |
| `MandateCreated` | subKey, customer | nonce, perChargeCap, totalCap, expiry |
| `MandateRevoked` | subKey, customer | nonce, reason (0 customer, 1 cancel, 2 replaced) |
| `ParameterUpdated` | key | oldValue, newValue |
| OZ pause and role events | per OZ | per OZ |

`SubscriptionPaymentProcessed` is the billing fact the backend turns into a payment and a paid invoice. For escrowed plans the same transaction also emits the escrow's `EscrowCreated` and `EscrowFunded`; `escrowKey` ties them together.

## 7. Administration

Roles: `DEFAULT_ADMIN_ROLE` (two-step, delayed, multisig), `CONFIG_ROLE` (bounded `maxPaymentAmount`, multisig, emits `ParameterUpdated`), `PAUSER_ROLE` (separate guardian, pause only, never the admin). No role can create, alter or cancel a customer's subscription or mandate, change a price, redirect a payout, or move any USDC. The manager has no privileged USDC permission other than the exact, per-call approval to the escrow, which returns to zero.

## 8. Worked example

Merchant publishes a 99 USDC, 30-day plan with 14-day vesting escrow. Customer approves 297 USDC to the manager, subscribes (pays 99 into a new escrow vesting over 14 days), then creates a mandate: per charge 99, total 297, 90 days. Thirty days later a bot calls `charge`: all checks pass, `spent = 99`, 99 USDC enters a second escrow, `nextChargeAt` moves 30 days forward. If the customer revokes, the next `charge` reverts `MandateInactive`; they can still `renew` manually.

## 9. Tests specific to this contract

Plan and subscription lifecycle, trial paths, manual and recurring charges, every mandate check in section 4 (one test per failing condition, plus boundary values), expiry exactly at `expiry`, cap exhaustion at the last unit, re-base after lapse, duplicate-period attempts in the same block and across manual/recurring mixes, price snapshot immutability, permissionless caller griefing attempts, pause matrix, role matrix, reentrancy via a hostile token mock, escrow integration (key linkage, allowance back to zero, manager balance zero), and invariants I5, I6, I7, I8, I9 from the parent doc.

## 10. Mandates (D8) and arbitrator acceptance (D5)

Mandates are created by an explicit on-chain customer transaction only (no signatures in v1). All checks in section 4 run inside `charge` itself. Arbitrator: a merchant proposes one allowlisted arbitrator in the plan; a customer who subscribes passes it as `acceptedArbitrator`, which is stored in the subscription and emitted. If the arbitrator is later removed from the allowlist, charges that need a new escrow revert (the customer keeps their funds) until the customer cancels; replacing an arbitrator on an existing escrow follows the escrow doc.
