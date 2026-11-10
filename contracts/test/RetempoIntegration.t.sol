// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {RetempoEscrow} from "../RetempoEscrow.sol";
import {RetempoSubscriptionManager} from "../RetempoSubscriptionManager.sol";
import {Unauthorized, DepositMismatch, AmountOutOfBounds, InvalidAmount} from "../interfaces/RetempoErrors.sol";
import {RetempoSystemBase} from "./helpers/RetempoSystemBase.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";

/// @dev Shared helpers for the cross-contract (manager + escrow) integration suites. No test functions.
abstract contract IntegrationHelpers is RetempoSystemBase {
    struct Pay {
        bytes32 subKey;
        bytes32 planKey;
        uint32 n;
        RetempoSubscriptionManager.PaymentTrigger trig;
        bytes32 rk;
        uint40 periodStart;
        bool rebased;
    }

    struct Snap {
        uint40 next;
        uint32 count;
        uint128 spent;
        uint256 cust;
        uint256 mgrBal;
        uint256 locked;
        uint256 escBal;
        uint256 payoutBal;
        bytes32 nextKey;
    }

    RetempoSubscriptionManager.PaymentTrigger internal constant MANUAL = RetempoSubscriptionManager.PaymentTrigger.Manual;
    RetempoSubscriptionManager.PaymentTrigger internal constant RECURRING = RetempoSubscriptionManager.PaymentTrigger.Recurring;

    /// @dev Settlement token handle (overridden by suites that swap the system token).
    function _t() internal view virtual returns (IERC20) {
        return IERC20(address(usdc));
    }

    /// @dev Escrow key exactly as specified: keccak256(abi.encode(merchant, keccak256(abi.encode(subKey, chargeCount)))).
    function _rk(bytes32 subKey, uint32 n) internal view returns (bytes32) {
        return keccak256(abi.encode(merchant, keccak256(abi.encode(subKey, n))));
    }

    function _refPlan(bytes32 ref, bool refundable) internal returns (bytes32 key) {
        vm.prank(merchant);
        key = mgr.createPlan(ref, payout, PRICE, INTERVAL, 0, GRACE, VEST, arb, refundable);
    }

    function _expectPay(Pay memory p) internal {
        vm.expectEmit(true, true, true, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionPaymentProcessed(
            p.subKey, p.planKey, customer, p.n, merchant, PRICE, p.trig, p.rk, p.periodStart, p.periodStart + INTERVAL, p.rebased
        );
    }

    function _expectEscrowEvents(bytes32 rk, bytes32 invoiceRef, uint40 at, bool refundable) internal {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit RetempoEscrow.EscrowCreated(rk, merchant, customer, invoiceRef, PRICE, VEST, arb, refundable, 7 days, 30 days);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit RetempoEscrow.ArbitratorAccepted(rk, customer, arb, true);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit RetempoEscrow.EscrowFunded(rk, address(mgr), PRICE, at, at + VEST, true);
    }

    function _assertRecord(bytes32 rk, bool refundable) internal view {
        RetempoEscrow.Escrow memory e = escrow.getEscrow(rk);
        assertEq(e.merchant, merchant, "merchant");
        assertEq(e.customer, customer, "customer");
        assertEq(e.arbitrator, arb, "arbitrator");
        assertEq(e.amount, PRICE, "amount");
        assertEq(e.vestDuration, VEST, "vestDuration");
        assertEq(e.customerMayRefundUnvested, refundable, "refund flag");
        assertEq(uint8(e.status), uint8(RetempoEscrow.Status.Active), "status Active");
        assertEq(e.vestStart, block.timestamp, "vestStart == now");
        assertEq(e.claimed + e.awarded + e.refunded + e.frozen, 0, "nothing allocated yet");
        assertEq(uint8(e.dispute), uint8(RetempoEscrow.DisputeState.None), "no dispute");
        assertEq(escrow.balanceOf(rk), PRICE, "held balance");
    }

    function _snap(bytes32 sk) internal view returns (Snap memory s) {
        RetempoSubscriptionManager.Subscription memory sub = mgr.getSubscription(sk);
        s.next = sub.nextChargeAt;
        s.count = sub.chargeCount;
        s.spent = mgr.getMandate(sk).spent;
        s.cust = _t().balanceOf(customer);
        s.mgrBal = _t().balanceOf(address(mgr));
        s.locked = escrow.totalLocked();
        s.escBal = _t().balanceOf(address(escrow));
        s.payoutBal = _t().balanceOf(payout);
        s.nextKey = _rk(sk, sub.chargeCount + 1);
    }

    function _assertSnapEq(Snap memory a, Snap memory b) internal view {
        assertEq(b.next, a.next, "nextChargeAt unchanged");
        assertEq(b.count, a.count, "chargeCount unchanged");
        assertEq(b.spent, a.spent, "mandate.spent unchanged");
        assertEq(b.cust, a.cust, "customer balance unchanged");
        assertEq(b.mgrBal, a.mgrBal, "manager balance unchanged");
        assertEq(b.locked, a.locked, "totalLocked unchanged");
        assertEq(b.escBal, a.escBal, "escrow token balance unchanged");
        assertEq(b.payoutBal, a.payoutBal, "payout balance unchanged");
        assertEq(uint8(escrow.getEscrow(a.nextKey).status), uint8(RetempoEscrow.Status.None), "no escrow record");
        assertEq(_t().allowance(address(mgr), address(escrow)), 0, "no residual allowance");
    }

    function _assertManagerClean() internal view {
        assertEq(_t().balanceOf(address(mgr)), 0, "manager holds nothing");
        assertEq(_t().allowance(address(mgr), address(escrow)), 0, "manager->escrow allowance is zero");
    }

    function _escrowSubWithMandate() internal returns (bytes32 planKey, bytes32 sk) {
        (planKey, sk) = _escrowSub();
        _mandate(sk, PRICE, 10 * PRICE, T0 + 300 days);
    }

    function _escrowStatus(bytes32 rk) internal view returns (uint8) {
        return uint8(escrow.getEscrow(rk).status);
    }

    /// @dev Keys 1..n are Active, the next three are untouched, and locked equals n deposits (single-sub system).
    function _assertOnlyN(bytes32 sk, uint32 n) internal view {
        for (uint32 i = 1; i <= n; ++i) {
            assertEq(_escrowStatus(_rk(sk, i)), uint8(RetempoEscrow.Status.Active), "period escrow exists");
        }
        for (uint32 i = n + 1; i <= n + 3; ++i) {
            assertEq(_escrowStatus(_rk(sk, i)), uint8(RetempoEscrow.Status.None), "no extra escrow");
        }
        assertEq(escrow.totalLocked(), uint256(n) * PRICE, "locked == n deposits");
    }

    function _expectNotDue(bool viaRenew, bytes32 sk) internal {
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        if (viaRenew) _renew(sk);
        else _charge(sk);
    }
}

/// @dev (a) exact escrow record per payment path, (c) duplicate execution / key uniqueness.
contract RetempoIntegrationFlowTest is IntegrationHelpers {
    // ------------------------------------------------------------------ (a) subscribe

    function test_A_Subscribe_EscrowPlan_CreatesExactRecordAndEvents() public {
        bytes32 planKey = _refPlan(PREF, true);
        bytes32 sk = mgr.subscriptionKey(customer, SREF);
        bytes32 rk = _rk(sk, 1);
        Snap memory b = _snap(sk);
        assertEq(_escrowStatus(rk), 0, "absent before");

        vm.expectEmit(true, true, true, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionCreated(sk, planKey, customer, SREF, PRICE, INTERVAL, uint40(T0), arb);
        _expectPay(Pay(sk, planKey, 1, MANUAL, rk, uint40(T0), false));
        _expectEscrowEvents(rk, keccak256(abi.encode(sk, uint32(1))), uint40(T0), true);
        _subscribe(planKey);

        _assertRecord(rk, true);
        assertEq(escrow.escrowKey(merchant, keccak256(abi.encode(sk, uint32(1)))), rk, "escrow derives same key");
        Snap memory a = _snap(sk);
        assertEq(a.locked, b.locked + PRICE, "totalLocked rises by amount");
        assertEq(a.cust, b.cust - PRICE, "customer pays amount");
        assertEq(a.escBal, b.escBal + PRICE, "escrow holds tokens");
        assertEq(a.payoutBal, b.payoutBal, "payout untouched");
        assertEq(mgr.getSubscription(sk).acceptedArbitrator, arb, "customer-accepted arbitrator recorded");
        assertEq(_escrowStatus(_rk(sk, 2)), 0, "exactly one escrow");
        _assertManagerClean();
    }

    function test_A_Renew_EscrowPlan_CreatesExactRecordAndEvents() public {
        bytes32 planKey = _refPlan(PREF, false);
        bytes32 sk = _subscribe(planKey);
        vm.warp(T0 + INTERVAL);
        bytes32 rk = _rk(sk, 2);
        Snap memory b = _snap(sk);
        _expectPay(Pay(sk, planKey, 2, MANUAL, rk, uint40(T0 + INTERVAL), false));
        _expectEscrowEvents(rk, keccak256(abi.encode(sk, uint32(2))), uint40(T0 + INTERVAL), false);
        _renew(sk);

        _assertRecord(rk, false);
        Snap memory a = _snap(sk);
        assertEq(a.locked, b.locked + PRICE);
        assertEq(a.cust, b.cust - PRICE);
        assertEq(a.count, 2);
        assertEq(a.next, T0 + 2 * INTERVAL);
        assertEq(a.spent, 0, "manual renew consumes no mandate");
        assertEq(_escrowStatus(_rk(sk, 1)), uint8(RetempoEscrow.Status.Active), "period 1 escrow untouched");
        _assertManagerClean();
    }

    function test_A_Charge_EscrowPlan_CreatesExactRecordAndEvents() public {
        bytes32 planKey = _refPlan(PREF, true);
        bytes32 sk = _subscribe(planKey);
        _stdMandate(sk);
        vm.warp(T0 + INTERVAL + 1 days); // late, inside grace -> not rebased
        bytes32 rk = _rk(sk, 2);
        Snap memory b = _snap(sk);
        _expectPay(Pay(sk, planKey, 2, RECURRING, rk, uint40(T0 + INTERVAL), false));
        _expectEscrowEvents(rk, keccak256(abi.encode(sk, uint32(2))), uint40(T0 + INTERVAL + 1 days), true);
        _charge(sk);

        _assertRecord(rk, true);
        Snap memory a = _snap(sk);
        assertEq(a.locked, b.locked + PRICE);
        assertEq(a.cust, b.cust - PRICE);
        assertEq(a.spent, PRICE, "mandate spent increments");
        assertEq(a.next, T0 + 2 * INTERVAL, "cadence anchored to prior due");
        assertEq(a.payoutBal, 0);
        _assertManagerClean();
    }

    function test_A_Charge_EmitsExactlyOneOfEachEscrowEvent() public {
        (, bytes32 sk) = _escrowSubWithMandate();
        vm.warp(T0 + INTERVAL);
        vm.recordLogs();
        _charge(sk);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 created;
        uint256 funded;
        uint256 accepted;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(escrow)) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == RetempoEscrow.EscrowCreated.selector) ++created;
            if (t0 == RetempoEscrow.EscrowFunded.selector) ++funded;
            if (t0 == RetempoEscrow.ArbitratorAccepted.selector) ++accepted;
        }
        assertEq(created, 1);
        assertEq(funded, 1);
        assertEq(accepted, 1);
    }

    function test_A_DirectPlan_NoEscrowAndPaysPayoutDirectly() public {
        bytes32 planKey = _directPlan();
        bytes32 sk = mgr.subscriptionKey(customer, SREF);
        _expectPay(Pay(sk, planKey, 1, MANUAL, bytes32(0), uint40(T0), false));
        _subscribe(planKey);
        assertEq(_t().balanceOf(payout), PRICE);
        _stdMandate(sk);

        vm.warp(T0 + INTERVAL);
        _renew(sk);
        vm.warp(T0 + 2 * INTERVAL);
        vm.recordLogs();
        _expectPay(Pay(sk, planKey, 3, RECURRING, bytes32(0), uint40(T0 + 2 * INTERVAL), false));
        _charge(sk);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(escrow), "direct plan never touches escrow");
        }
        assertEq(_t().balanceOf(payout), 3 * PRICE, "payout received every period");
        assertEq(_t().balanceOf(customer), CUSTOMER_FUNDS - 3 * PRICE);
        assertEq(escrow.totalLocked(), 0);
        assertEq(_t().balanceOf(address(escrow)), 0);
        for (uint32 i = 1; i <= 4; ++i) assertEq(_escrowStatus(_rk(sk, i)), 0, "no escrow record");
        _assertManagerClean();
    }

    function test_A_TrialEscrowPlan_FirstChargeViaRecurringCreatesPeriodOneEscrow() public {
        bytes32 planKey = _plan(PREF, PRICE, INTERVAL, 2 days, GRACE, VEST);
        bytes32 sk = _subscribe(planKey);
        assertEq(escrow.totalLocked(), 0, "trial subscribe locks nothing");
        _stdMandate(sk);
        vm.warp(T0 + 2 days);
        _charge(sk);
        _assertRecord(_rk(sk, 1), false);
        assertEq(_sub(sk).chargeCount, 1);
        assertEq(_escrowStatus(_rk(sk, 2)), 0);
    }

    // ------------------------------------------------------------------ (c) duplicate execution

    function test_C_SubscribeThenChargeOrRenewSameBlock_NotDue() public {
        (, bytes32 sk) = _escrowSubWithMandate();
        Snap memory b = _snap(sk);
        _expectNotDue(false, sk);
        _expectNotDue(true, sk);
        _assertSnapEq(b, _snap(sk));
        _assertOnlyN(sk, 1);
    }

    function test_C_ChargeTwiceSamePeriod_SecondNotDue() public {
        (, bytes32 sk) = _escrowSubWithMandate();
        vm.warp(T0 + INTERVAL);
        _charge(sk);
        Snap memory b = _snap(sk);
        _expectNotDue(false, sk);
        _assertSnapEq(b, _snap(sk));
        _assertOnlyN(sk, 2);
        assertEq(_man(sk).spent, PRICE, "one recurring spend");
    }

    function test_C_ChargeThenRenewSamePeriod_RenewNotDue() public {
        (, bytes32 sk) = _escrowSubWithMandate();
        vm.warp(T0 + INTERVAL);
        _charge(sk);
        _expectNotDue(true, sk);
        _assertOnlyN(sk, 2);
    }

    function test_C_RenewThenChargeSamePeriod_ChargeNotDue() public {
        (, bytes32 sk) = _escrowSubWithMandate();
        vm.warp(T0 + INTERVAL);
        _renew(sk);
        _expectNotDue(false, sk);
        _expectNotDue(true, sk);
        _assertOnlyN(sk, 2);
        assertEq(_man(sk).spent, 0);
    }

    function test_C_TrialSubscribeThenRenewThenCharge_OnlyOneEscrow() public {
        bytes32 planKey = _plan(PREF, PRICE, INTERVAL, 1 days, GRACE, VEST);
        bytes32 sk = _subscribe(planKey);
        _stdMandate(sk);
        vm.warp(T0 + 1 days);
        _renew(sk);
        _expectNotDue(false, sk);
        _expectNotDue(true, sk);
        _assertOnlyN(sk, 1);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionExists.selector);
        mgr.subscribe(SREF, planKey, arb);
        _assertOnlyN(sk, 1);
    }

    function test_C_EscrowKeysNeverCollideAcrossPeriods() public {
        (, bytes32 sk) = _escrowSubWithMandate();
        uint32 periods = 8;
        for (uint32 i = 1; i < periods; ++i) {
            vm.warp(T0 + uint256(i) * INTERVAL);
            if (i % 2 == 0) _renew(sk);
            else _charge(sk);
        }
        bytes32[] memory keys = new bytes32[](periods);
        for (uint32 i; i < periods; ++i) {
            keys[i] = _rk(sk, i + 1);
            assertEq(_escrowStatus(keys[i]), uint8(RetempoEscrow.Status.Active));
            for (uint32 j; j < i; ++j) assertTrue(keys[i] != keys[j], "keys distinct");
        }
        assertEq(_sub(sk).chargeCount, periods);
        assertEq(escrow.totalLocked(), uint256(periods) * PRICE);
    }

    function test_C_TwoCustomersSameRefOnSamePlan_DistinctEscrowKeys() public {
        bytes32 planKey = _escrowPlan();
        bytes32 s1 = _subscribeAs(customer, SREF, planKey);
        bytes32 s2 = _subscribeAs(customer2, SREF, planKey);
        assertTrue(s1 != s2, "sub keys differ");
        assertTrue(_rk(s1, 1) != _rk(s2, 1), "escrow keys differ");
        assertEq(escrow.getEscrow(_rk(s1, 1)).customer, customer);
        assertEq(escrow.getEscrow(_rk(s2, 1)).customer, customer2);
        assertEq(escrow.totalLocked(), 2 * PRICE);
    }

    function test_C_RebaseAfterLapse_ProducesNextDistinctEscrowKey() public {
        bytes32 planKey = _escrowPlan();
        bytes32 sk = _subscribe(planKey);
        uint256 lateAt = T0 + INTERVAL + GRACE + 1; // one second beyond grace
        vm.warp(lateAt);
        bytes32 rk2 = _rk(sk, 2);
        _expectPay(Pay(sk, planKey, 2, MANUAL, rk2, uint40(lateAt), true));
        _renew(sk);
        assertTrue(rk2 != _rk(sk, 1));
        assertEq(_sub(sk).nextChargeAt, lateAt + INTERVAL, "cadence rebased to now");
        assertEq(escrow.getEscrow(rk2).vestStart, lateAt);
        _assertOnlyN(sk, 2);
        // the very next period charges normally under the rebased cadence
        vm.warp(lateAt + INTERVAL);
        _renew(sk);
        _assertOnlyN(sk, 3);
    }

    function test_C_PaymentInsideGrace_DoesNotRebase() public {
        bytes32 planKey = _escrowPlan();
        bytes32 sk = _subscribe(planKey);
        vm.warp(T0 + INTERVAL + GRACE); // exactly at grace edge: not rebased
        bytes32 rk2 = _rk(sk, 2);
        _expectPay(Pay(sk, planKey, 2, MANUAL, rk2, uint40(T0 + INTERVAL), false));
        _renew(sk);
        assertEq(_sub(sk).nextChargeAt, T0 + 2 * INTERVAL);
    }

}

/// @dev (b) failed charges leave no inconsistent state; a retry after the fix bills exactly one period.
contract RetempoIntegrationFailureTest is IntegrationHelpers {
    bytes32 internal sk;

    /// @dev Escrow subscription paid at T0, warped to the next due time (no mandate).
    function _prime() internal {
        (, sk) = _escrowSub();
        vm.warp(T0 + INTERVAL);
    }

    function _primeM() internal {
        _prime();
        _stdMandate(sk);
    }

    function _attempt(bool viaRenew) internal {
        if (viaRenew) _renew(sk);
        else _charge(sk);
    }

    /// @dev The call reverts with `err` and every observable is identical afterwards (optionally for renew too).
    function _expectFail(bytes memory err, bool alsoRenew) internal {
        Snap memory a = _snap(sk);
        vm.expectRevert(err);
        _charge(sk);
        _assertSnapEq(a, _snap(sk));
        if (alsoRenew) {
            vm.expectRevert(err);
            _renew(sk);
            _assertSnapEq(a, _snap(sk));
        }
    }

    /// @dev Retry after the cause is fixed: exactly one period billed, exactly one new escrow.
    function _retryOk(bool viaRenew) internal {
        Snap memory b = _snap(sk);
        _attempt(viaRenew);
        Snap memory a = _snap(sk);
        assertEq(a.count, b.count + 1, "one period billed");
        assertEq(a.next, b.next + INTERVAL, "cadence advanced one interval");
        assertEq(a.spent, b.spent + (viaRenew ? 0 : PRICE), "spent");
        assertEq(a.cust, b.cust - PRICE, "customer paid once");
        assertEq(a.locked, b.locked + PRICE, "locked + once");
        assertEq(a.escBal, b.escBal + PRICE, "escrow tokens + once");
        assertEq(uint8(escrow.getEscrow(b.nextKey).status), uint8(RetempoEscrow.Status.Active), "escrow created");
        assertEq(escrow.getEscrow(b.nextKey).vestStart, block.timestamp);
        assertEq(uint8(escrow.getEscrow(a.nextKey).status), uint8(RetempoEscrow.Status.None), "no second escrow");
        _assertManagerClean();
    }

    function test_B_EscrowPaused() public {
        _primeM();
        vm.prank(pauser);
        escrow.pause();
        _expectFail(abi.encodeWithSelector(Pausable.EnforcedPause.selector), true);
        vm.prank(admin);
        escrow.unpause();
        _retryOk(false);
    }

    function test_B_EscrowExposureLimitExceeded() public {
        _primeM();
        vm.prank(configMgr);
        escrow.setMaxAggregateExposure(2 * uint256(PRICE) - 1);
        _expectFail(
            abi.encodeWithSelector(RetempoEscrow.ExposureExceeded.selector, uint256(PRICE), uint256(PRICE), 2 * uint256(PRICE) - 1), true
        );
        vm.prank(configMgr);
        escrow.setMaxAggregateExposure(MAX_EXPOSURE);
        _retryOk(true);
    }

    function test_B_EscrowMaxAmountLoweredBelowPrice() public {
        _primeM();
        uint256 minA = escrow.minAmount();
        vm.prank(configMgr);
        escrow.setMaxEscrowAmount(uint256(PRICE) - 1);
        _expectFail(abi.encodeWithSelector(AmountOutOfBounds.selector, uint256(PRICE), minA, uint256(PRICE) - 1), true);
        vm.prank(configMgr);
        escrow.setMaxEscrowAmount(10_000e6);
        _retryOk(false);
    }

    function test_B_EscrowMinAmountRaisedAbovePrice() public {
        _primeM();
        uint256 minA = escrow.minAmount();
        vm.prank(configMgr);
        escrow.setMinAmount(uint256(PRICE) + 1);
        _expectFail(abi.encodeWithSelector(InvalidAmount.selector), true);
        vm.prank(configMgr);
        escrow.setMinAmount(minA);
        _retryOk(true);
    }

    function test_B_ArbitratorRemovedFromAllowlist() public {
        _primeM();
        vm.prank(arbMgr);
        escrow.removeArbitrator(arb);
        _expectFail(abi.encodeWithSelector(RetempoEscrow.ArbitratorNotAllowed.selector), true);
        vm.prank(arbMgr);
        escrow.addArbitrator(arb);
        _retryOk(false);
    }

    function test_B_ArbitratorBecomesConflictedViaRoleGrant() public {
        _primeM();
        bytes32 role = escrow.CONFIG_ROLE();
        vm.prank(admin);
        escrow.grantRole(role, arb);
        _expectFail(abi.encodeWithSelector(RetempoEscrow.ConflictedArbitrator.selector), true);
        vm.prank(admin);
        escrow.revokeRole(role, arb);
        _retryOk(true);
    }

    function test_B_InsufficientAllowance() public {
        _primeM();
        vm.prank(customer);
        usdc.approve(address(mgr), uint256(PRICE) - 1);
        _expectFail(
            abi.encodeWithSelector(
                RetempoSubscriptionManager.InsufficientAllowance.selector, customer, uint256(PRICE), uint256(PRICE) - 1
            ),
            true
        );
        _approveMgr(customer);
        _retryOk(false);
    }

    function test_B_InsufficientBalance() public {
        _primeM();
        uint256 bal = usdc.balanceOf(customer);
        uint256 moved = bal - (uint256(PRICE) - 1);
        vm.prank(customer);
        usdc.transfer(customer2, moved);
        _expectFail(
            abi.encodeWithSelector(
                RetempoSubscriptionManager.InsufficientBalance.selector, customer, uint256(PRICE), uint256(PRICE) - 1
            ),
            true
        );
        usdc.mint(customer, 1);
        _retryOk(true);
    }

    function test_B_SubscriptionCanceled() public {
        _primeM();
        vm.prank(customer);
        mgr.cancelSubscription(sk);
        _expectFail(abi.encodeWithSelector(RetempoSubscriptionManager.SubscriptionInactive.selector), true);
        assertEq(escrow.totalLocked(), PRICE);
    }

    function test_B_MandateMissing() public {
        _prime();
        _expectFail(abi.encodeWithSelector(RetempoSubscriptionManager.MandateMissing.selector), false);
        _stdMandate(sk);
        _retryOk(false);
    }

    function test_B_MandateRevoked() public {
        _primeM();
        vm.prank(customer);
        mgr.revokeMandate(sk);
        _expectFail(abi.encodeWithSelector(RetempoSubscriptionManager.MandateInactive.selector), false);
        _stdMandate(sk);
        _retryOk(false);
    }

    function test_B_MandateExpired() public {
        _prime();
        _mandate(sk, PRICE, 5 * PRICE, block.timestamp + 1);
        vm.warp(block.timestamp + 1); // expiry is exclusive
        _expectFail(abi.encodeWithSelector(RetempoSubscriptionManager.MandateExpired.selector), false);
        _stdMandate(sk);
        _retryOk(false);
    }

    function test_B_MandateTotalCapExhausted() public {
        _prime();
        _mandate(sk, PRICE, PRICE, block.timestamp + 200 days);
        _charge(sk); // consumes the whole cap
        vm.warp(T0 + 2 * INTERVAL);
        _expectFail(abi.encodeWithSelector(RetempoSubscriptionManager.TotalCapExceeded.selector), false);
        _renew(sk); // customer-paid renewal consumes no cap and works
        assertEq(_sub(sk).chargeCount, 3);
        vm.warp(T0 + 3 * INTERVAL);
        _stdMandate(sk); // fresh generation resets spent
        _retryOk(false);
    }

    function test_B_PerChargeCapBelowPriceCannotExist() public {
        _prime();
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.InvalidMandateCaps.selector);
        mgr.createMandate(sk, PRICE - 1, 5 * PRICE, uint40(block.timestamp + 90 days));
        _expectFail(abi.encodeWithSelector(RetempoSubscriptionManager.MandateMissing.selector), false);
    }

    function test_B_EscrowCallReverts() public {
        _primeM();
        vm.mockCallRevert(
            address(escrow), abi.encodeWithSelector(RetempoEscrow.fundFromManager.selector), abi.encodeWithSelector(Unauthorized.selector)
        );
        _expectFail(abi.encodeWithSelector(Unauthorized.selector), true);
        vm.clearMockedCalls();
        _retryOk(false);
    }

    function test_B_EscrowReturnsWrongKey() public {
        _primeM();
        vm.mockCall(address(escrow), abi.encodeWithSelector(RetempoEscrow.fundFromManager.selector), abi.encode(bytes32(uint256(1))));
        _expectFail(abi.encodeWithSelector(RetempoSubscriptionManager.UnexpectedEscrowKey.selector), true);
        vm.clearMockedCalls();
        _retryOk(true);
    }

    function test_B_EscrowLeavesResidualAllowance() public {
        _primeM();
        bytes32 next = _snap(sk).nextKey;
        // escrow "succeeds" with the right key but never pulls the approved tokens
        vm.mockCall(address(escrow), abi.encodeWithSelector(RetempoEscrow.fundFromManager.selector), abi.encode(next));
        _expectFail(abi.encodeWithSelector(RetempoSubscriptionManager.ResidualEscrowAllowance.selector), true);
        vm.clearMockedCalls();
        _retryOk(false);
    }

    function test_B_DirectPlanFailuresAreAtomicToo() public {
        bytes32 planKey = _directPlan();
        bytes32 dsk = _subscribe(planKey);
        _stdMandate(dsk);
        vm.warp(T0 + INTERVAL);
        sk = dsk;
        Snap memory a = _snap(dsk);
        vm.prank(customer);
        usdc.approve(address(mgr), uint256(PRICE) - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                RetempoSubscriptionManager.InsufficientAllowance.selector, customer, uint256(PRICE), uint256(PRICE) - 1
            )
        );
        _charge(dsk);
        _assertSnapEq(a, _snap(dsk));
        _approveMgr(customer);
        uint256 bal = usdc.balanceOf(customer);
        vm.prank(customer);
        usdc.transfer(customer2, bal - 1);
        a = _snap(dsk);
        vm.expectRevert(
            abi.encodeWithSelector(RetempoSubscriptionManager.InsufficientBalance.selector, customer, uint256(PRICE), uint256(1))
        );
        _charge(dsk);
        _assertSnapEq(a, _snap(dsk));
        vm.prank(customer2);
        usdc.transfer(customer, bal - 1);
        _charge(dsk);
        assertEq(_sub(dsk).chargeCount, 2);
        assertEq(usdc.balanceOf(payout), 2 * PRICE);
        assertEq(escrow.totalLocked(), 0);
    }

}

/// @dev (b) fee-on-transfer settlement token: escrow plans fail closed with no residue.
contract RetempoIntegrationFeeTokenTest is IntegrationHelpers {
    FeeOnTransferToken internal fee;
    bytes32 internal sk;

    function _t() internal view override returns (IERC20) {
        return IERC20(address(fee));
    }

    function setUp() public override {
        vm.warp(T0);
        fee = new FeeOnTransferToken();
        _wire(address(fee));
        fee.mint(customer, CUSTOMER_FUNDS);
        vm.prank(customer);
        fee.approve(address(mgr), type(uint256).max);
    }

    function _trialEscrowLive() internal {
        bytes32 planKey = _plan(PREF, PRICE, INTERVAL, 1 days, GRACE, VEST);
        sk = _subscribe(planKey);
        _stdMandate(sk);
        vm.warp(T0 + 1 days);
    }

    function test_B_FeeToken_ChargeAndRenewRevertAtomically() public {
        _trialEscrowLive();
        Snap memory a = _snap(sk);
        bytes memory err = abi.encodeWithSelector(DepositMismatch.selector, uint256(PRICE), uint256(0), fee.received(PRICE));
        vm.expectRevert(err);
        _charge(sk);
        _assertSnapEq(a, _snap(sk));
        vm.expectRevert(err);
        _renew(sk);
        _assertSnapEq(a, _snap(sk));
        assertEq(escrow.totalLocked(), 0);
        assertEq(fee.totalSupply(), CUSTOMER_FUNDS, "nothing burned by the reverted attempt");
    }

    function test_B_FeeToken_SubscribeRevertsAndRecordsNothing() public {
        bytes32 planKey = _escrowPlan();
        bytes32 key = mgr.subscriptionKey(customer, SREF);
        bytes memory err = abi.encodeWithSelector(DepositMismatch.selector, uint256(PRICE), uint256(0), fee.received(PRICE));
        vm.prank(customer);
        vm.expectRevert(err);
        mgr.subscribe(SREF, planKey, arb);
        assertEq(uint8(_sub(key).status), 0, "no subscription");
        assertEq(_escrowStatus(_rk(key, 1)), 0, "no escrow");
        assertEq(fee.balanceOf(customer), CUSTOMER_FUNDS);
        assertEq(fee.totalSupply(), CUSTOMER_FUNDS);
        _assertManagerClean();
    }

}

/// @dev (d) accounting consistency and end-to-end escrow lifecycle on manager-created escrows.
contract RetempoIntegrationAccountingTest is IntegrationHelpers {
    bytes32 internal constant EVID = keccak256("evidence");
    bytes32 internal constant PREF2 = keccak256("plan-2");
    bytes32 internal constant SREF2 = keccak256("sub-2");

    function _assertConsistent(bytes32 sk, uint32 n, uint256 withdrawn) internal view {
        uint256 deposits = uint256(n) * PRICE;
        uint256 summed;
        for (uint32 i = 1; i <= n; ++i) summed += escrow.getEscrow(_rk(sk, i)).amount;
        assertEq(summed, deposits, "sum of escrow deposits");
        assertEq(CUSTOMER_FUNDS - usdc.balanceOf(customer), deposits, "customer outflow == deposits");
        assertEq(escrow.totalLocked() + escrow.totalWithdrawable() + withdrawn, deposits, "liabilities + withdrawn == deposits");
        assertEq(usdc.balanceOf(address(escrow)), escrow.totalLocked() + escrow.totalWithdrawable(), "token balance == liabilities");
        assertEq(usdc.balanceOf(payout), 0, "no direct payout");
        _assertManagerClean();
    }

    function test_D_MultiPeriod_DepositsEqualOutflowAndLiabilities() public {
        bytes32 planKey = _refPlan(PREF, false);
        bytes32 sk = _subscribe(planKey);
        _mandate(sk, PRICE, 10 * PRICE, T0 + 300 days);
        _assertConsistent(sk, 1, 0);
        uint32 periods = 6;
        for (uint32 i = 1; i < periods; ++i) {
            vm.warp(T0 + uint256(i) * INTERVAL);
            if (i % 2 == 0) _renew(sk);
            else _charge(sk);
            _assertConsistent(sk, i + 1, 0);
        }
        // everything is vested VEST after the last period started; claim one escrow, withdraw, then the rest
        vm.warp(block.timestamp + VEST);
        vm.prank(merchant);
        escrow.claim(_rk(sk, 1));
        assertEq(escrow.totalLocked(), 5 * PRICE);
        assertEq(escrow.withdrawableOf(merchant), PRICE);
        _assertConsistent(sk, periods, 0);
        vm.prank(merchant);
        escrow.withdraw(merchant);
        assertEq(usdc.balanceOf(merchant), PRICE, "merchant received claimed amount");
        assertEq(escrow.totalWithdrawable(), 0);
        for (uint32 i = 2; i <= periods; ++i) {
            vm.prank(merchant);
            escrow.claim(_rk(sk, i));
        }
        assertEq(escrow.totalLocked(), 0);
        assertEq(escrow.withdrawableOf(merchant), 5 * PRICE);
        vm.prank(merchant);
        escrow.withdraw(merchant);
        assertEq(usdc.balanceOf(merchant), 6 * PRICE);
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow fully drained, no liabilities");
        assertEq(escrow.totalLocked() + escrow.totalWithdrawable(), 0);
        for (uint32 i = 1; i <= periods; ++i) {
            assertEq(uint8(escrow.getEscrow(_rk(sk, i)).status), uint8(RetempoEscrow.Status.Closed));
        }
        _assertManagerClean();
    }

    function test_D_CustomerUnvestedRefund_EndToEnd() public {
        bytes32 planKey = _refPlan(PREF, true);
        bytes32 sk = _subscribe(planKey);
        bytes32 rk = _rk(sk, 1);
        vm.warp(T0 + VEST / 2);
        vm.prank(customer);
        escrow.customerRefundUnvested(rk);
        assertEq(escrow.withdrawableOf(customer), PRICE / 2, "unvested half credited");
        assertEq(escrow.claimableAmount(rk), PRICE / 2, "vested half still claimable by merchant");
        vm.prank(merchant);
        escrow.claim(rk);
        assertEq(uint8(escrow.getEscrow(rk).status), uint8(RetempoEscrow.Status.Closed));
        vm.prank(customer);
        escrow.withdraw(customer);
        vm.prank(merchant);
        escrow.withdraw(merchant);
        assertEq(usdc.balanceOf(customer), CUSTOMER_FUNDS - PRICE / 2);
        assertEq(usdc.balanceOf(merchant), PRICE / 2);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalLocked() + escrow.totalWithdrawable(), 0);
        // billing continues independently with a fresh, distinct escrow
        vm.warp(T0 + INTERVAL);
        _renew(sk);
        assertEq(_escrowStatus(_rk(sk, 2)), uint8(RetempoEscrow.Status.Active));
        _assertManagerClean();
    }

    function test_D_NonRefundablePlan_CustomerRefundReverts() public {
        bytes32 sk = _subscribe(_refPlan(PREF, false));
        vm.warp(T0 + 1 days);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.RefundNotAllowed.selector);
        escrow.customerRefundUnvested(_rk(sk, 1));
        assertEq(escrow.totalLocked(), PRICE);
    }

    function test_D_DisputeOnManagerEscrow_ArbitratorAcceptanceSemantics() public {
        bytes32 sk = _subscribe(_refPlan(PREF, false));
        bytes32 rk = _rk(sk, 1);
        // the arbitrator the customer accepted in the subscription is the escrow's arbitrator
        assertEq(_sub(sk).acceptedArbitrator, arb);
        assertEq(escrow.getEscrow(rk).arbitrator, _sub(sk).acceptedArbitrator);
        vm.warp(T0 + 3 days);
        vm.prank(customer);
        escrow.openDispute(rk, PRICE, EVID);
        assertEq(uint8(escrow.getEscrow(rk).dispute), uint8(RetempoEscrow.DisputeState.Open));
        assertEq(escrow.getEscrow(rk).frozen, PRICE);
        // only the accepted arbitrator can rule; merchant response unlocks resolution early
        vm.prank(merchant);
        escrow.respondToDispute(rk, EVID);
        vm.prank(arb2);
        vm.expectRevert(Unauthorized.selector);
        escrow.resolveDispute(rk, 1, EVID);
        vm.prank(arb);
        escrow.resolveDispute(rk, 60e6, EVID);
        assertEq(escrow.withdrawableOf(merchant), 60e6);
        assertEq(escrow.withdrawableOf(customer), 40e6);
        assertEq(uint8(escrow.getEscrow(rk).status), uint8(RetempoEscrow.Status.Closed));
        vm.prank(merchant);
        escrow.withdraw(merchant);
        vm.prank(customer);
        escrow.withdraw(customer);
        assertEq(usdc.balanceOf(merchant), 60e6);
        assertEq(usdc.balanceOf(customer), CUSTOMER_FUNDS - 60e6);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        // the manager keeps billing: a dispute on period 1 does not touch period 2
        vm.warp(T0 + INTERVAL);
        _renew(sk);
        assertEq(uint8(escrow.getEscrow(_rk(sk, 2)).dispute), uint8(RetempoEscrow.DisputeState.None));
        _assertManagerClean();
    }

    // ------------------------------------------------------------------ (e) pause independence

    function test_E_ManagerPaused_EscrowClaimRefundDisputeWithdrawStillWork() public {
        bytes32 planA = _refPlan(PREF, true);
        bytes32 planB = _refPlan(PREF2, false);
        bytes32 skRefund = _subscribeAs(customer, SREF, planA);
        bytes32 skDispute = _subscribeAs(customer, SREF2, planB);
        bytes32 skClaim = _subscribeAs(customer2, SREF, planB);
        _pauseMgr();
        _expectPausedRenew(skRefund);
        vm.warp(T0 + VEST / 2);

        vm.prank(customer);
        escrow.customerRefundUnvested(_rk(skRefund, 1));
        vm.prank(customer);
        escrow.openDispute(_rk(skDispute, 1), PRICE, EVID);
        vm.prank(merchant);
        escrow.respondToDispute(_rk(skDispute, 1), EVID);
        vm.prank(arb);
        escrow.resolveDispute(_rk(skDispute, 1), PRICE / 4, EVID);
        vm.prank(merchant);
        escrow.claim(_rk(skClaim, 1));
        vm.prank(merchant);
        escrow.claim(_rk(skRefund, 1));
        assertGt(escrow.withdrawableOf(merchant), 0);
        vm.prank(merchant);
        escrow.withdraw(merchant);
        vm.prank(customer);
        escrow.withdraw(customer);
        assertEq(usdc.balanceOf(address(escrow)), escrow.totalLocked() + escrow.totalWithdrawable());
        assertTrue(mgr.paused());
    }

    function _expectPausedRenew(bytes32 sk) internal {
        vm.prank(customer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        mgr.renew(sk);
    }

    function test_E_EscrowPaused_ManagerRevokeCancelAndEscrowExitsStillWork() public {
        bytes32 planA = _escrowPlan();
        bytes32 sk1 = _subscribeAs(customer, SREF, planA);
        bytes32 sk2 = _subscribeAs(customer2, SREF, planA);
        _stdMandate(sk1);
        vm.prank(customer2);
        mgr.createMandate(sk2, PRICE, 3 * PRICE, uint40(block.timestamp + 90 days));
        vm.prank(pauser);
        escrow.pause();
        assertTrue(escrow.paused());

        vm.prank(customer);
        mgr.revokeMandate(sk1);
        assertFalse(_man(sk1).active);
        vm.prank(customer);
        mgr.cancelSubscription(sk1);
        vm.prank(merchant);
        mgr.cancelSubscription(sk2); // merchant-initiated cancel also works
        assertEq(uint8(_sub(sk1).status), uint8(RetempoSubscriptionManager.SubStatus.Canceled));
        assertEq(uint8(_sub(sk2).status), uint8(RetempoSubscriptionManager.SubStatus.Canceled));
        assertFalse(_man(sk2).active);

        // escrow exits keep working while the escrow is paused
        vm.warp(T0 + VEST);
        vm.prank(merchant);
        escrow.claim(_rk(sk1, 1));
        vm.prank(merchant);
        escrow.withdraw(merchant);
        assertEq(usdc.balanceOf(merchant), PRICE);
    }

    function test_E_EscrowPaused_NewEscrowPaymentsBlockedButStateConsistent() public {
        (, bytes32 sk) = _escrowSubWithMandate();
        vm.prank(pauser);
        escrow.pause();
        vm.warp(T0 + INTERVAL);
        Snap memory a = _snap(sk);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _charge(sk);
        _assertSnapEq(a, _snap(sk));
        bytes32 planKey = _refPlan(PREF2, false);
        vm.prank(customer2);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        mgr.subscribe(SREF, planKey, arb);
        assertEq(uint8(_sub(mgr.subscriptionKey(customer2, SREF)).status), 0);
    }

    // ------------------------------------------------------------------ (f) linkage

    function test_F_PositiveLinkage() public {
        (RetempoEscrow e, RetempoSubscriptionManager m) = _deploySystem(address(usdc));
        assertEq(e.manager(), address(m));
        assertEq(address(m.escrow()), address(e));
        assertEq(address(m.usdc()), address(e.usdc()));
    }

    function test_F_ConstructorRevertsWhenEscrowManagerDiffers() public {
        RetempoEscrow e = new RetempoEscrow(address(usdc), makeAddr("notManager"), admin, ADMIN_DELAY, pauser, configMgr, arbMgr, MAX_EXPOSURE);
        vm.expectRevert(RetempoSubscriptionManager.ManagerLinkMismatch.selector);
        new RetempoSubscriptionManager(address(usdc), address(e), admin, ADMIN_DELAY, pauser, configMgr);
        // an escrow already wired to the live manager cannot be adopted by a second manager
        vm.expectRevert(RetempoSubscriptionManager.ManagerLinkMismatch.selector);
        new RetempoSubscriptionManager(address(usdc), address(escrow), admin, ADMIN_DELAY, pauser, configMgr);
    }

    function test_F_ConstructorRevertsWhenTokenDiffers() public {
        address other = address(new FeeOnTransferToken());
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        RetempoEscrow e = new RetempoEscrow(address(usdc), predicted, admin, ADMIN_DELAY, pauser, configMgr, arbMgr, MAX_EXPOSURE);
        vm.expectRevert(RetempoSubscriptionManager.TokenLinkMismatch.selector);
        new RetempoSubscriptionManager(other, address(e), admin, ADMIN_DELAY, pauser, configMgr);
    }

    function test_F_OnlyManagerCanFundFromManager() public {
        vm.prank(customer);
        usdc.approve(address(escrow), type(uint256).max); // even a direct escrow allowance gives nobody a path
        address[9] memory callers = [stranger, admin, merchant, customer, arb, pauser, configMgr, arbMgr, address(escrow)];
        uint256 custBefore = usdc.balanceOf(customer);
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Unauthorized.selector);
            escrow.fundFromManager(keccak256("x"), merchant, customer, PRICE, VEST, arb, false);
        }
        assertEq(usdc.balanceOf(customer), custBefore);
        assertEq(escrow.totalLocked(), 0);
        assertEq(uint8(escrow.getEscrow(escrow.escrowKey(merchant, keccak256("x"))).status), 0);
    }

}
