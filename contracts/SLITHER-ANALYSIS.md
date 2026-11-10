# Slither analysis: independent investigation of the three High findings

> Historical imported author analysis, not an independent audit. Its execution/attestation claims are not current evidence. The current Phase 3 run uses Slither 0.11.6; exact JSON, source references and exit status are in `docs/phase-3-evidence/slither-results.json` and `slither-run.json`. A zero tool exit with `--fail-none` does not mean zero findings or production approval.

Scope: `contracts/RetempoEscrow.sol` and `contracts/RetempoSubscriptionManager.sol` as they stand at the final source (MD5 `165e0a77b381e8f8c96abaeeb5a20433` and `20cd0237a0fea3f62ea86f1abdbcbb8f`; `interfaces/RetempoErrors.sol` `7fd9b4aa3614083caf10f4098ca3653d`). Slither was run once on this exact source (`slither . --filter-paths "node_modules|lib/|contracts/script|contracts/test" --exclude naming-convention,solc-version,pragma`, 26 results). The sources were not edited afterwards. Result: **no code change was needed for the three High findings.** Each is explained below with the exact path and with executable evidence. This is the author's analysis, not an independent audit.

## H-1 and H-2: `arbitrary-send-erc20` (two instances)

| Item | Detail |
| --- | --- |
| Functions | `RetempoSubscriptionManager._executePayment` (`usdc.safeTransferFrom(s.customer, p.payout, s.amount)`) and `RetempoSubscriptionManager._fundEscrow` (`usdc.safeTransferFrom(s.customer, address(this), amount)`) |
| What Slither sees | A `transferFrom` whose `from` is not `msg.sender`, so any caller might move someone else's tokens. |
| Entry points that reach it | `subscribe` (caller must be the customer), `renew` (caller must be `s.customer`), `charge` (anyone may call). |
| Why `from` cannot be chosen by an attacker | `s.customer` is written once, in `subscribe`, as `msg.sender`. The subscription key is `keccak256(abi.encode(customer, externalRef))`, so a stranger cannot create a subscription for a victim. `renew` checks `msg.sender == s.customer`. `charge` is permissionless, but every transfer it can trigger is bounded by state the customer created. |
| What bounds a `charge` | Subscription Active; price snapshot (`s.amount`, fixed at subscribe, cannot be raised); `now >= nextChargeAt` (one period at a time); a mandate created by the customer that is active, unexpired, has `amount <= perChargeCap` and `spent + amount <= totalCap`; the customer's own allowance and balance. The recipient is the plan payout or the escrow, never the caller. |
| Worst case if every check passes | The customer is billed exactly the price they accepted, once per period, until their own mandate cap, expiry or revocation. |
| Residual trust | The plan merchant can change `payout` (`setPlanPayout`). That redirects the merchant's own revenue only; a customer's payment amount and cadence do not change. |
| Impact if the assumption were wrong | Direct loss of customer funds up to their allowance. For that reason the argument above is tested, not just asserted. |

Evidence (all executed, final source): `contracts/test/RetempoSlitherFindings.t.sol`, `RetempoArbitrarySendEvidenceTest` (16 tests): victim with a maximum allowance but no subscription cannot be charged or renewed by a stranger; a stranger's `subscribe` binds the stranger; a victim with no mandate, a revoked, expired, cancelled or exhausted mandate cannot be charged; the debit always equals the price snapshot and goes to the payout or escrow; only the merchant changes the payout; non-customers cannot renew; two fuzz tests (256 runs each) show a non-subscribed victim never loses funds and the recipient is never the caller. `RetempoSubscriptionManager.Mandate.t.sol` and `.Security.t.sol` cover every mandate rule individually.

Verdict: **accepted, by design.** Pulling funds from a customer who pre-authorized them is the product. The finding is a pattern match on `transferFrom(from != msg.sender)`.

## H-3: `reentrancy-balance` in `_fundEscrow`

| Item | Detail |
| --- | --- |
| Function | `RetempoSubscriptionManager._fundEscrow` |
| Slither's claim | `beforeBalance = usdc.balanceOf(this)` is read, then `escrow.fundFromManager(...)` is called (external), then `usdc.balanceOf(this) != beforeBalance` is evaluated: the balance read could be stale if the callee re-enters and changes it. |
| Calls in the path | `usdc.balanceOf`, `usdc.safeTransferFrom(customer -> manager)`, `usdc.forceApprove(escrow)`, `escrow.fundFromManager`, `usdc.allowance`, `usdc.balanceOf`. |
| Who can run code in the middle | Only `escrow` (immutable, linkage proven in the constructor: `escrow.manager() == address(this)` and `escrow.usdc() == usdc`) and the immutable `usdc`. `escrow.fundFromManager` runs only its own code plus one `transferFrom` on the same token. The token is Circle USDC, which has no transfer hooks or callbacks into the sender, receiver or owner, so no untrusted code executes. |
| If untrusted code could run | `subscribe`, `renew` and `charge` are `nonReentrant`, so a callback cannot start another payment. Calls into other manager functions cannot move USDC or alter the balance (they are plan or mandate bookkeeping). The post-call check is a fail-safe: if anything changed the manager balance, the whole payment **reverts** (`ManagerBalanceChanged`); it can only reject, never accept a bad state. |
| Donations | A donation made before the call is included in `beforeBalance` (the baseline is read inside the call). A donation in another transaction cannot interleave. Donated funds stay in the manager (no sweep function, by design). |
| Impact if wrong | A payment could complete while leaving residual USDC or allowance in the manager. The code additionally asserts `allowance(manager, escrow) == 0`. |

Evidence (executed): `RetempoBalanceMutationEvidenceTest` (15 tests) with `BalanceMutatingToken`: a balance change injected before or after the customer pull produces `DepositMismatch`; injected before or after the escrow pull produces `ManagerBalanceChanged`; injected into the escrow produces the escrow's `DepositMismatch`; callbacks into guarded manager or escrow functions revert `ReentrancyGuardReentrantCall`; callbacks into unguarded functions revert `Unauthorized`; every revert leaves identical state and the disarmed retry bills exactly once; a donation in an earlier transaction does not break payments; allowance to the escrow is zero after every success. Also `test_Reentrancy_*` in the Manager suite (8 hook tests with `ReentrantToken`) and, on the real Arc USDC predeploy, `contracts/test/arc/ArcUsdc.t.sol` test 09b (forced native funding does not affect liabilities).

Verdict: **accepted, with documented assumptions**: (1) the token is the real Arc USDC with no callbacks (checked by the deployment script via `decimals()` and the address); (2) the escrow is the immutable contract the constructor validated. If the project ever supports a token with transfer hooks, this function must be redesigned. No source change was made because adding `slither-disable` comments would alter audited code and bytecode metadata.

## Medium and Low results (not Highs, listed for completeness)

| Result | Where | Assessment |
| --- | --- | --- |
| `incorrect-equality` x4 | `claim`, `customerRefundUnvested`, `_refund`, `_withdraw`: `amount == 0` | Zero-amount guards on an integer computed by the contract; there is no balance-based equality. Benign. |
| `uninitialized-local` x4 | `_executePayment` (`invoiceRef`, `routedKey`, `context`) and `canCharge` (`context`) | Intentionally zero-default memory/locals; `invoiceRef` and `routedKey` are only used when `vestDuration != 0`, where they are assigned. Benign. |
| `timestamp` x14 | vesting, windows, expiry, charge timing | Time is the product (hours to days). Arc timestamps are non-decreasing, not strictly increasing; no logic requires strict increase. |

## Residual risk that Slither cannot see (documented, not fixed in code)

- The USDC issuer can blocklist the escrow contract itself or pause USDC. Credits keep accumulating but `withdraw` fails until the issuer lifts it; tested in `ArcUsdc.Faults.t.sol` test 05 and 08. Operational response: monitor `isBlacklisted(escrow)` and `paused()`, coordinate with the issuer, announce an incident. There is no on-chain escape hatch by design (no admin sweep).
- Unsolicited USDC sent to either contract is permanently unrecoverable (no sweep function), by design.
