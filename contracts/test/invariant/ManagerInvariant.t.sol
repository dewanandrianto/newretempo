// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console2} from "forge-std/Test.sol";
import {RetempoSystemBase} from "../helpers/RetempoSystemBase.sol";
import {RetempoSubscriptionManager as M} from "../../RetempoSubscriptionManager.sol";
import {RetempoEscrow} from "../../RetempoEscrow.sol";
import {ManagerInvariantHandler as H} from "./ManagerInvariantHandler.sol";

/// @notice Handler-driven stateful invariants I5-I9 (+ conservation, payment cap, failed-call purity, liveness)
///         for RetempoSubscriptionManager with the real RetempoEscrow behind it.
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 100
/// forge-config: default.invariant.fail-on-revert = false
contract ManagerInvariantTest is RetempoSystemBase {
    H internal h;

    // ok[] indices (mirrors the handler constants)
    uint256 internal constant OK_MANDATE = 2;
    uint256 internal constant OK_CHARGE = 3;
    uint256 internal constant OK_RENEW = 4;
    uint256 internal constant OK_ESCROWPAY = 5;
    uint256 internal constant OK_CHARGE_ESCROW = 22;
    uint256 internal constant OK_SUB_PAID = 27;
    uint256 internal constant OK_RENEW_ESCROW = 28;

    function setUp() public override {
        super.setUp();
        h = new H(mgr, escrow, usdc, admin, pauser, configMgr, arbMgr, arb, arb2);
        _seed();
        h.resetOk(); // seeding must not count towards the per-run coverage guard
        targetContract(address(h));
        // Arc rejects zero-address transaction senders before EVM execution.
        // Zero-valued function arguments remain fully fuzzed.
        excludeSender(address(0));
        // Handler actions select and prank every protocol actor themselves.
        // The outer dispatcher is not an authorization input; keep it a valid EOA
        // rather than fuzzing Arc-forbidden system/burn transaction senders.
        targetSender(makeAddr("invariant-transaction-sender"));
        _weights();
    }

    /// @dev Seeds every fuzz run (indices are handler plan / subscription indices):
    ///      plans  P0 direct  P1 direct+trial  P2 escrow  P3 escrow+trial  P4 direct daily  P5 escrow 3d
    ///      subs   S0 fresh | S1 escrow, active mandate | S2 daily, mandate nearly exhausted (40/60 spent)
    ///             S3 trial due, no mandate | S4 escrow trial, mandate | S5 mandate expired
    ///             S6 mandate revoked | S7 canceled | S8 lapsed beyond grace, no mandate | S9 mandate replaced
    function _seed() internal {
        uint256 p0 = _plan6(0, 100e6, 30 days, 0, 3 days, 0);
        uint256 p1 = _plan6(1, 50e6, 14 days, 7 days, 2 days, 0);
        uint256 p2 = _plan6(0, 200e6, 10 days, 0, 2 days, 14 days);
        uint256 p3 = _plan6(3, 80e6, 7 days, 5 days, 1 days, 3 days);
        uint256 p4 = _plan6(0, 20e6, 1 days, 0, 0, 0);
        uint256 p5 = _plan6(1, 150e6, 3 days, 0, 1 days, 1 days);

        h.seedSub(0, p0); // S0
        h.seedSub(1, p2); // S1
        h.seedMandate(1, 200e6, 600e6, 90 days);
        h.seedSub(2, p4); // S2
        h.seedMandate(2, 20e6, 60e6, 60 days);
        h.seedSub(0, p1); // S3 (trial)
        h.seedSub(1, p3); // S4 (escrow trial)
        h.seedMandate(4, 80e6, 320e6, 60 days);
        h.seedSub(2, p5); // S5
        h.seedMandate(5, 150e6, 450e6, 2 days + 12 hours);
        h.seedSub(1, p4); // S6
        h.seedMandate(6, 20e6, 60e6, 60 days);
        h.seedRevoke(6);
        h.seedSub(0, p4); // S7
        h.seedCancel(7, false);
        h.seedSub(2, p2); // S8
        h.seedSub(0, p5); // S9
        h.seedMandate(9, 150e6, 300e6, 30 days);
        h.seedMandate(9, 150e6, 600e6, 80 days); // replaces the first mandate (nonce 2)

        h.seedWarp(1 days);
        h.seedCharge(2); // spent 20e6
        h.seedWarp(1 days);
        h.seedCharge(2); // spent 40e6 of 60e6: one charge left
        h.seedWarp(1 days);
        h.seedWarp(11 days); // t0 + 14 days: S5 mandate expired, S8 / S1 / S4 lapsed beyond grace

        assertEq(h.subsLength(), 10, "seed: subs");
        assertEq(mgr.getMandate(h.subAt(2).key).spent, 40e6, "seed: S2 nearly exhausted");
        assertEq(mgr.getMandate(h.subAt(9).key).nonce, 2, "seed: S9 replaced");
        assertEq(_reasonOf(0), 5, "seed: S0 not due");
        assertEq(_reasonOf(1), 0, "seed: S1 chargeable");
        assertEq(_reasonOf(2), 0, "seed: S2 chargeable");
        assertEq(_reasonOf(3), 6, "seed: S3 no mandate");
        assertEq(_reasonOf(5), 8, "seed: S5 mandate expired");
        assertEq(_reasonOf(6), 7, "seed: S6 mandate revoked");
        assertEq(_reasonOf(7), 1, "seed: S7 canceled");
        assertEq(_reasonOf(8), 6, "seed: S8 lapsed, no mandate");
        assertGt(block.timestamp, uint256(mgr.getSubscription(h.subAt(8).key).nextChargeAt) + 2 days, "seed: S8 lapsed");
    }

    function _plan6(uint256 who, uint128 amount, uint32 interval, uint32 trial, uint32 grace, uint32 vest)
        internal
        returns (uint256)
    {
        H.PlanG memory n;
        n.amount = amount;
        n.interval = interval;
        n.trial = trial;
        n.grace = grace;
        n.vest = vest;
        return h.seedPlan(who, n);
    }

    function _reasonOf(uint256 i) internal view returns (uint8) {
        return _reason(h.subAt(i).key);
    }

    bytes4[] internal sel;

    function _w(bytes4 s, uint256 n) internal {
        for (uint256 i; i < n; ++i) sel.push(s);
    }

    /// @dev A selector listed N times is N times as likely: core lifecycle actions dominate (~50%);
    ///      pause / config / role / fault actions are rare and self-repairing.
    function _weights() internal {
        _w(h.createMandate.selector, 5);
        _w(h.charge.selector, 8);
        _w(h.renew.selector, 9);
        _w(h.subscribe.selector, 4);
        _w(h.createPlan.selector, 2);
        _w(h.revoke.selector, 2);
        _w(h.cancel.selector, 2);
        _w(h.setPlanActive.selector, 1);
        _w(h.setPlanPayout.selector, 1);
        _w(h.warp.selector, 7);
        _w(h.donate.selector, 1);
        _w(h.customerTweak.selector, 1);
        _w(h.pause.selector, 1);
        _w(h.unpause.selector, 2);
        _w(h.setMaxPaymentAmount.selector, 1);
        _w(h.squeezeLimit.selector, 1);
        _w(h.roleToggle.selector, 1);
        _w(h.escrowFault.selector, 1);
        _w(h.roleMisuse.selector, 1);
        _w(h.strangerMisuse.selector, 2);
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    // ───────────────────────── invariants ─────────────────────────

    /// I5: no successful recurring charge on a revoked, replaced, canceled or expired mandate. The handler snapshots
    ///     the mandate / subscription with the getters right before every charge and flags a success on any of them.
    function invariant_I5_NoChargeOnRevokedReplacedCanceledOrExpiredMandate() public view {
        assertFalse(h.vRevoked(), "charge succeeded on inactive/expired mandate or canceled subscription");
        uint256 n = h.subsLength();
        for (uint256 i; i < n; ++i) {
            H.SubG memory g = h.subAt(i);
            M.Mandate memory m = mgr.getMandate(g.key);
            if (g.canceled) {
                assertEq(mgr.getSubscription(g.key).chargeCount, g.cancelCount, "payment after cancellation");
                assertFalse(m.active, "canceled subscription kept an active mandate");
            }
            if (!g.mActive) {
                assertEq(h.recurSum(h.nonceKey(g.key, m.nonce)), g.deactSum, "recurring charge after deactivation");
            }
        }
    }

    /// I6: spent <= totalCap, charge <= perChargeCap, sum of recurring amounts per mandate nonce == spent.
    function invariant_I6_MandateCapsAndSpentAccounting() public view {
        assertFalse(h.vCaps(), "cap / spent accounting violated at a payment");
        uint256 n = h.subsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 k = h.subAt(i).key;
            M.Mandate memory m = mgr.getMandate(k);
            assertLe(m.spent, m.totalCap, "spent > totalCap");
            assertLe(m.perChargeCap, m.totalCap, "perChargeCap > totalCap");
            assertLe(m.totalCap, mgr.HARD_MAX_AMOUNT(), "totalCap > hard max");
            assertGe(m.perChargeCap, m.nonce == 0 ? 0 : mgr.getSubscription(k).amount, "perChargeCap < price");
            assertEq(m.spent, h.recurSum(h.nonceKey(k, m.nonce)), "spent != sum of recurring amounts of this nonce");
        }
    }

    /// I7: a billing period is never charged twice; every payment is due and leaves nextChargeAt in the future.
    function invariant_I7_BillingPeriodNeverChargedTwice() public view {
        assertFalse(h.vPeriod(), "payment before due / bad nextChargeAt / period charged twice");
        uint256 n = h.subsLength();
        for (uint256 i; i < n; ++i) {
            H.SubG memory g = h.subAt(i);
            M.Subscription memory s = mgr.getSubscription(g.key);
            assertEq(s.chargeCount, g.count, "chargeCount != successful payments");
            assertEq(s.nextChargeAt, g.expectedNext, "nextChargeAt drifted");
            uint256 first = uint256(g.subscribedAt) + g.trial;
            assertGe(s.nextChargeAt, first + uint256(g.count) * g.interval, "fewer elapsed periods than payments");
            if (g.count > 0) {
                assertGt(s.nextChargeAt, g.lastPay, "nextChargeAt not after last payment");
                assertLe(g.count, 1 + (block.timestamp - first) / g.interval, "more payments than elapsed periods");
            } else {
                assertEq(s.nextChargeAt, first, "unpaid subscription due date moved");
            }
        }
    }

    /// I8: neither role holders nor strangers can change a subscription's customer / amount / status, a mandate,
    ///     a plan's price / arbitrator, or move customer USDC.
    function invariant_I8_RolesAndStrangersCannotAlterTermsOrFunds() public view {
        assertFalse(h.vRole(), "role / stranger action changed subscriptions, mandates, plans or customer USDC");
        assertFalse(h.vMisuse(), "an unauthorized call succeeded");
        uint256 n = h.subsLength();
        for (uint256 i; i < n; ++i) {
            H.SubG memory g = h.subAt(i);
            M.Subscription memory s = mgr.getSubscription(g.key);
            assertEq(s.customer, g.customer, "customer changed");
            assertEq(s.planKey, g.planKey, "plan changed");
            assertEq(s.amount, g.amount, "amount changed");
            assertEq(s.interval, g.interval, "interval changed");
            assertEq(s.grace, g.grace, "grace changed");
            assertEq(s.acceptedArbitrator, g.accepted, "accepted arbitrator changed");
            assertEq(uint8(s.status), g.canceled ? uint8(M.SubStatus.Canceled) : uint8(M.SubStatus.Active), "status");
            M.Mandate memory m = mgr.getMandate(g.key);
            assertEq(m.nonce, g.mNonce, "mandate nonce");
            assertEq(m.perChargeCap, g.mPer, "mandate perChargeCap");
            assertEq(m.totalCap, g.mTotal, "mandate totalCap");
            assertEq(m.expiry, g.mExpiry, "mandate expiry");
            assertEq(m.active, g.mActive, "mandate active");
        }
        uint256 np = h.plansLength();
        for (uint256 i; i < np; ++i) {
            H.PlanG memory g = h.planAt(i);
            M.Plan memory p = mgr.getPlan(g.key);
            assertEq(p.merchant, g.merchant, "plan merchant");
            assertEq(p.amount, g.amount, "plan price");
            assertEq(p.arbitrator, g.arbitrator, "plan arbitrator");
            assertEq(p.interval, g.interval, "plan interval");
            assertEq(p.trial, g.trial, "plan trial");
            assertEq(p.grace, g.grace, "plan grace");
            assertEq(p.vestDuration, g.vest, "plan vest");
            assertEq(p.customerMayRefundUnvested, g.refundable, "plan refundable");
            assertEq(p.payout, g.payoutG, "plan payout (merchant-only)");
            assertEq(p.active, g.activeG, "plan active (merchant-only)");
        }
        // customer USDC only moves through payments the customer is charged for, or the customer's own transfers
        for (uint256 i; i < h.customersLength(); ++i) {
            address c = h.customers(i);
            assertEq(usdc.balanceOf(c), h.minted(c) - h.paid(c) - h.sunk(c), "customer USDC moved unexplained");
        }
    }

    /// I9: the manager holds nothing (only tracked donations) and never leaves an allowance to the escrow.
    function invariant_I9_ManagerHoldsNothingAndNoResidualAllowance() public view {
        assertFalse(h.vMgrBal(), "manager balance changed across a call");
        assertFalse(h.vAllowance(), "manager left a nonzero escrow allowance after a call");
        assertEq(usdc.balanceOf(address(mgr)), h.ghostDonated(), "manager holds more than donations");
        assertEq(usdc.allowance(address(mgr), address(escrow)), 0, "residual allowance to escrow");
    }

    /// Conservation: customer decrease == payout increase (direct) / escrow totalLocked increase (escrow); routed
    /// escrow key / amount / parties match; reverted calls change nothing.
    function invariant_Conservation_PaymentsRouteExactly() public view {
        assertFalse(h.vConserve(), "customer decrease != payout / escrow increase");
        assertFalse(h.vEscrow(), "routed escrow key / terms mismatch");
        assertFalse(h.vFail(), "a reverted call changed observable state");
        assertEq(escrow.totalLocked(), h.ghostLocked(), "totalLocked != sum of escrow-plan payments");
        assertEq(usdc.balanceOf(address(escrow)), h.ghostLocked(), "escrow USDC != locked");
        uint256 sumPayouts;
        for (uint256 i; i < h.payoutsLength(); ++i) sumPayouts += usdc.balanceOf(h.payouts(i));
        assertEq(sumPayouts, h.ghostDirect(), "payout balances != sum of direct payments");
        uint256 sumB;
        uint256 nk = h.escrowKeysLength();
        for (uint256 i; i < nk; ++i) sumB += escrow.balanceOf(h.escrowKeys(i));
        assertEq(sumB, h.ghostLocked(), "sum of routed escrow balances != ghost");
    }

    /// No successful payment ever exceeded maxPaymentAmount at the moment it executed.
    function invariant_PaymentNeverAboveMaxPaymentAmount() public view {
        assertFalse(h.vPaymentCap(), "payment above maxPaymentAmount");
    }

    /// Liveness: a charge / renew whose pre-conditions all hold (pre-call getters) never reverts.
    function invariant_LivenessWhenAllChecksPass() public view {
        assertFalse(h.vLive(), "payment reverted although every pre-condition held");
    }

    /// INV_LOG=true prints per-run success counters. The coverage guard fails any run that never exercised the
    /// core actions (counters were zeroed after seeding, so only fuzzer-driven successes count).
    function afterInvariant() public view {
        if (vm.envOr("INV_LOG", false)) {
            string memory s;
            for (uint256 i; i < 29; ++i) s = string.concat(s, vm.toString(h.ok(i)), ",");
            console2.log("ok-counts", s);
        }
        // Per-run guard. Individual actions (for example createMandate) legitimately fail to succeed in some
        // 100-call runs, so the guard only requires that the money-moving paths were exercised in every run;
        // per-action reachability is proven separately by test_HandlerSmoke_EveryActionSucceedsAtLeastOnce.
        require(h.ok(OK_CHARGE) + h.ok(OK_RENEW) + h.ok(OK_SUB_PAID) > 0, "coverage: no payment succeeded in this run");
        require(h.ok(OK_ESCROWPAY) + h.ok(OK_CHARGE_ESCROW) + h.ok(OK_RENEW_ESCROW) > 0, "coverage: no escrow-plan payment succeeded in this run");
    }

    // ───────────────────────── handler smoke (proves every action can succeed) ─────────────────────────

    function test_HandlerSmoke_EveryActionSucceedsAtLeastOnce() public {
        // recurring charges: first scan hits S1 (escrow, lapsed), the second S2 (direct, lapsed)
        h.charge(0, 0);
        h.charge(0, 0);
        // renewals: S3 (direct, trial due) then S4 (escrow, trial due)
        h.renew(0, 0);
        h.renew(0, 0);
        // plans: direct+trial, escrow; subscriptions: paid immediately, trial
        h.createPlan(0, 50e6);
        h.createPlan(1 << 8, 50e6);
        h.subscribe(0, 0);
        h.subscribe(0, 1);
        // mandates: fresh and replacement (HasMandate branch)
        h.createMandate(0, 1);
        h.createMandate(0, 0);
        h.revoke(0);
        h.cancel(0, 0); // merchant cancels
        h.cancel(0, 1); // customer cancels
        h.setPlanActive(0);
        h.setPlanActive(0);
        h.setPlanPayout(0);
        h.warp(5 days);
        h.donate(1);
        h.customerTweak(0);
        h.customerTweak(1 << 8);
        h.customerTweak(2 << 8);
        // role holders, misuse, strangers
        h.roleToggle(0);
        h.setMaxPaymentAmount(5_000e6, 0);
        h.squeezeLimit(0);
        for (uint256 i; i < 14; ++i) h.roleMisuse(i);
        for (uint256 i; i < 7; ++i) h.strangerMisuse(i, i);
        h.pause(0);
        h.unpause();
        h.escrowFault(0); // pauses the escrow (auto-repaired by later ticks)

        for (uint256 i; i < 29; ++i) assertGt(h.ok(i), 0, string.concat("action never succeeded: ", vm.toString(i)));
        assertFalse(h.vRevoked());
        assertFalse(h.vCaps());
        assertFalse(h.vPeriod());
        assertFalse(h.vRole());
        assertFalse(h.vMisuse());
        assertFalse(h.vMgrBal());
        assertFalse(h.vAllowance());
        assertFalse(h.vConserve());
        assertFalse(h.vEscrow());
        assertFalse(h.vPaymentCap());
        assertFalse(h.vFail());
        assertFalse(h.vLive());
        invariant_I5_NoChargeOnRevokedReplacedCanceledOrExpiredMandate();
        invariant_I6_MandateCapsAndSpentAccounting();
        invariant_I7_BillingPeriodNeverChargedTwice();
        invariant_I8_RolesAndStrangersCannotAlterTermsOrFunds();
        invariant_I9_ManagerHoldsNothingAndNoResidualAllowance();
        invariant_Conservation_PaymentsRouteExactly();
    }

    /// The seeded states behave as documented: lapse / expiry / revocation / cancel really block recurring charges.
    function test_SeededStatesBlockOrAllowCharges() public {
        bytes32 k2 = h.subAt(2).key;
        bytes32 k5 = h.subAt(5).key;
        bytes32 k6 = h.subAt(6).key;
        bytes32 k7 = h.subAt(7).key;
        bytes32 k8 = h.subAt(8).key;
        h.seedCharge(1); // S1: active mandate, lapsed -> rebased escrow charge succeeds
        vm.expectRevert(M.MandateExpired.selector);
        mgr.charge(k5);
        vm.expectRevert(M.MandateInactive.selector);
        mgr.charge(k6);
        vm.expectRevert(M.SubscriptionInactive.selector);
        mgr.charge(k7);
        vm.expectRevert(M.MandateMissing.selector);
        mgr.charge(k8);
        h.seedCharge(2); // last charge of S2's cap (60e6)
        assertEq(mgr.getMandate(k2).spent, 60e6);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(M.TotalCapExceeded.selector);
        mgr.charge(k2);
    }
}
