// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {RetempoEscrow} from "../RetempoEscrow.sol";
import {RetempoSubscriptionManager} from "../RetempoSubscriptionManager.sol";
import {Unauthorized} from "../interfaces/RetempoErrors.sol";
import {RetempoSystemBase} from "./helpers/RetempoSystemBase.sol";

/// @dev revoke/cancel, duplicate-period prevention, re-base, cadence and snapshot immutability.
contract RetempoSubscriptionManagerLifecycleTest is RetempoSystemBase {
    bytes32 internal planKey;
    bytes32 internal subKey;

    function _setupMandate() internal {
        (planKey, subKey) = _directSub();
        _mandate(subKey, PRICE, 10 * PRICE, T0 + 300 days);
    }

    // ------------------------------------------------------------ revokeMandate

    function test_Revoke_DeactivatesAndEmits() public {
        _setupMandate();
        vm.expectEmit(true, true, false, true, address(mgr));
        emit RetempoSubscriptionManager.MandateRevoked(subKey, customer, 1, 0);
        vm.prank(customer);
        mgr.revokeMandate(subKey);
        assertFalse(_man(subKey).active);
        assertEq(_man(subKey).nonce, 1);
        vm.warp(T0 + INTERVAL);
        vm.expectRevert(RetempoSubscriptionManager.MandateInactive.selector);
        _charge(subKey);
        _renew(subKey); // manual payment still possible after revocation
        assertEq(_sub(subKey).chargeCount, 2);
    }

    function test_Revoke_OnlyCustomer() public {
        _setupMandate();
        address[5] memory callers = [stranger, merchant, admin, pauser, customer2];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Unauthorized.selector);
            mgr.revokeMandate(subKey);
        }
        assertTrue(_man(subKey).active);
        vm.prank(customer);
        vm.expectRevert(Unauthorized.selector);
        mgr.revokeMandate(keccak256("unknown"));
    }

    function test_Revoke_NoMandateOrDoubleRevokeReverts() public {
        (planKey, subKey) = _directSub();
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.MandateInactive.selector);
        mgr.revokeMandate(subKey);
        _stdMandate(subKey);
        vm.prank(customer);
        mgr.revokeMandate(subKey);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.MandateInactive.selector);
        mgr.revokeMandate(subKey);
    }

    function test_Revoke_WorksWhilePaused() public {
        _setupMandate();
        _pauseMgr();
        vm.prank(customer);
        mgr.revokeMandate(subKey);
        assertFalse(_man(subKey).active);
    }

    // ------------------------------------------------------------ cancelSubscription

    function test_Cancel_ByCustomerDeactivatesMandateAndEmitsBoth() public {
        _setupMandate();
        vm.expectEmit(true, true, false, true, address(mgr));
        emit RetempoSubscriptionManager.MandateRevoked(subKey, customer, 1, 1);
        vm.expectEmit(true, true, false, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionCanceled(subKey, customer, customer);
        vm.prank(customer);
        mgr.cancelSubscription(subKey);
        assertEq(uint8(_sub(subKey).status), uint8(RetempoSubscriptionManager.SubStatus.Canceled));
        assertFalse(_man(subKey).active);
    }

    function test_Cancel_ByMerchantRecordsMerchantAsCaller() public {
        _setupMandate();
        vm.expectEmit(true, true, false, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionCanceled(subKey, customer, merchant);
        vm.prank(merchant);
        mgr.cancelSubscription(subKey);
        assertEq(uint8(_sub(subKey).status), uint8(RetempoSubscriptionManager.SubStatus.Canceled));
        assertFalse(_man(subKey).active);
    }

    function test_Cancel_WithoutMandateEmitsOnlyCanceled() public {
        (planKey, subKey) = _directSub();
        vm.recordLogs();
        vm.prank(customer);
        mgr.cancelSubscription(subKey);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], RetempoSubscriptionManager.SubscriptionCanceled.selector);
    }

    function test_Cancel_StrangerReverts() public {
        (planKey, subKey) = _directSub();
        address[6] memory callers = [stranger, admin, pauser, configMgr, customer2, merchant2];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Unauthorized.selector);
            mgr.cancelSubscription(subKey);
        }
        assertEq(uint8(_sub(subKey).status), uint8(RetempoSubscriptionManager.SubStatus.Active));
    }

    function test_Cancel_DoubleCancelAndUnknownRevert() public {
        (planKey, subKey) = _directSub();
        vm.prank(customer);
        mgr.cancelSubscription(subKey);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionInactive.selector);
        mgr.cancelSubscription(subKey);
        vm.prank(merchant);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionInactive.selector);
        mgr.cancelSubscription(subKey);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionInactive.selector);
        mgr.cancelSubscription(keccak256("unknown"));
    }

    function test_Cancel_WorksWhilePaused_BothParties() public {
        (planKey, subKey) = _directSub();
        bytes32 sub2 = _subscribeAs(customer2, SREF, planKey);
        _pauseMgr();
        vm.prank(customer);
        mgr.cancelSubscription(subKey);
        vm.prank(merchant);
        mgr.cancelSubscription(sub2);
        assertEq(uint8(_sub(subKey).status), 2);
        assertEq(uint8(_sub(sub2).status), 2);
    }

    function test_Cancel_MerchantCanCancelEvenAfterPlanDeactivated() public {
        (planKey, subKey) = _directSub();
        vm.startPrank(merchant);
        mgr.setPlanActive(planKey, false);
        mgr.cancelSubscription(subKey);
        vm.stopPrank();
        assertEq(uint8(_sub(subKey).status), 2);
    }

    function test_Cancel_BlocksFurtherPaymentsAndMandates_NoRefund() public {
        _setupMandate();
        uint256 payoutBefore = usdc.balanceOf(payout);
        uint256 custBefore = usdc.balanceOf(customer);
        vm.prank(customer);
        mgr.cancelSubscription(subKey);
        assertEq(usdc.balanceOf(payout), payoutBefore); // paid period is not refunded...
        assertEq(usdc.balanceOf(customer), custBefore); // ...and nothing else moves
        vm.warp(T0 + INTERVAL);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionInactive.selector);
        mgr.renew(subKey);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionInactive.selector);
        _charge(subKey);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionInactive.selector);
        mgr.createMandate(subKey, PRICE, PRICE, uint40(T0 + 100 days));
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.MandateInactive.selector);
        mgr.revokeMandate(subKey);
    }

    // ------------------------------------------------------------ duplicate-period prevention

    function test_Duplicate_TwoChargesSameTimestamp() public {
        _setupMandate();
        vm.warp(T0 + INTERVAL);
        _charge(subKey);
        uint256 payoutAfterFirst = usdc.balanceOf(payout);
        uint256 custAfterFirst = usdc.balanceOf(customer);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        _charge(subKey);
        assertEq(usdc.balanceOf(payout), payoutAfterFirst);
        assertEq(usdc.balanceOf(customer), custAfterFirst);
        assertEq(_sub(subKey).chargeCount, 2);
        assertEq(_man(subKey).spent, PRICE);
    }

    function test_Duplicate_RenewThenCharge() public {
        _setupMandate();
        vm.warp(T0 + INTERVAL);
        _renew(subKey);
        uint256 payoutAfterFirst = usdc.balanceOf(payout);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        _charge(subKey);
        assertEq(usdc.balanceOf(payout), payoutAfterFirst);
        assertEq(_sub(subKey).chargeCount, 2);
    }

    function test_Duplicate_ChargeThenRenew() public {
        _setupMandate();
        vm.warp(T0 + INTERVAL);
        _charge(subKey);
        uint256 payoutAfterFirst = usdc.balanceOf(payout);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        mgr.renew(subKey);
        assertEq(usdc.balanceOf(payout), payoutAfterFirst);
        assertEq(_sub(subKey).chargeCount, 2);
    }

    function test_Duplicate_RenewTwiceSameBlock() public {
        (planKey, subKey) = _directSub();
        // first period was paid at subscribe; renewing in the same block must fail
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        mgr.renew(subKey);
        assertEq(usdc.balanceOf(payout), PRICE);
    }

    function test_Duplicate_EscrowPlanDoesNotCreateSecondEscrow() public {
        (planKey, subKey) = _escrowSub();
        _mandate(subKey, PRICE, 10 * PRICE, T0 + 300 days);
        vm.warp(T0 + INTERVAL);
        _charge(subKey);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        _charge(subKey);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        mgr.renew(subKey);
        assertEq(usdc.balanceOf(address(escrow)), 2 * PRICE);
        assertEq(uint8(escrow.getEscrow(_routedKey(merchant, subKey, 3)).status), 0);
    }

    // ------------------------------------------------------------ re-base and cadence

    function test_Rebase_LateChargeRebasesAndBillsOnlyOnePeriod() public {
        _setupMandate();
        uint256 t = T0 + 5 * INTERVAL + 123;
        vm.warp(t);
        vm.expectEmit(true, true, true, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionPaymentProcessed(
            subKey, planKey, customer, 2, merchant, PRICE, RetempoSubscriptionManager.PaymentTrigger.Recurring, bytes32(0), uint40(t), uint40(t + INTERVAL), true
        );
        _charge(subKey);
        assertEq(_sub(subKey).nextChargeAt, t + INTERVAL);
        assertEq(_sub(subKey).chargeCount, 2); // missed periods are not billed
        assertEq(usdc.balanceOf(payout), 2 * PRICE);
        assertEq(_man(subKey).spent, PRICE);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        _charge(subKey);
        // next period is due exactly one interval after the re-base
        vm.warp(t + INTERVAL - 1);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        _charge(subKey);
        vm.warp(t + INTERVAL);
        _charge(subKey);
        assertEq(_sub(subKey).chargeCount, 3);
    }

    function test_Rebase_RecurringGraceBoundary() public {
        _setupMandate();
        uint256 snap = vm.snapshotState();
        vm.warp(T0 + INTERVAL + GRACE); // exactly at grace end: cadence preserved
        _charge(subKey);
        assertEq(_sub(subKey).nextChargeAt, T0 + 2 * INTERVAL);
        vm.revertToState(snap);
        vm.warp(T0 + INTERVAL + GRACE + 1); // one second later: re-base
        _charge(subKey);
        assertEq(_sub(subKey).nextChargeAt, T0 + INTERVAL + GRACE + 1 + INTERVAL);
    }

    function test_Cadence_NoDriftWhenLateWithinGrace() public {
        _setupMandate();
        vm.warp(T0 + INTERVAL + GRACE); // late but within grace
        _charge(subKey);
        assertEq(_sub(subKey).nextChargeAt, T0 + 2 * INTERVAL);
        vm.warp(T0 + 2 * INTERVAL - 1);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        _charge(subKey);
        vm.warp(T0 + 2 * INTERVAL); // the original cadence, not shifted by the late payment
        _charge(subKey);
        assertEq(_sub(subKey).nextChargeAt, T0 + 3 * INTERVAL);
    }

    function test_Cadence_FiveOnTimeChargesKeepGrid() public {
        _setupMandate();
        for (uint256 i = 1; i <= 5; ++i) {
            vm.warp(T0 + i * INTERVAL);
            _charge(subKey);
            assertEq(_sub(subKey).nextChargeAt, T0 + (i + 1) * INTERVAL);
            assertEq(_sub(subKey).chargeCount, i + 1);
        }
        assertEq(usdc.balanceOf(payout), 6 * PRICE);
    }

    function test_Trial_FirstChargeAfterTrialRebasesWhenLate() public {
        planKey = _trialPlan(7 days);
        subKey = _subscribe(planKey);
        uint256 t = T0 + 7 days + GRACE + 1;
        vm.warp(t);
        _renew(subKey);
        assertEq(_sub(subKey).nextChargeAt, t + INTERVAL);
    }

    // ------------------------------------------------------------ manual renew vs mandate cap

    function test_ManualRenewDoesNotConsumeMandateCap() public {
        (planKey, subKey) = _directSub();
        _mandate(subKey, PRICE, PRICE, T0 + 300 days); // room for exactly one recurring charge
        vm.warp(T0 + INTERVAL);
        _renew(subKey);
        assertEq(_man(subKey).spent, 0);
        assertEq(_man(subKey).nonce, 1);
        vm.warp(T0 + 2 * INTERVAL);
        _charge(subKey); // still has full cap
        assertEq(_man(subKey).spent, PRICE);
        vm.warp(T0 + 3 * INTERVAL);
        vm.expectRevert(RetempoSubscriptionManager.TotalCapExceeded.selector);
        _charge(subKey);
        _renew(subKey); // customer can still pay by hand
        assertEq(_man(subKey).spent, PRICE);
        assertEq(_sub(subKey).chargeCount, 4);
    }

    // ------------------------------------------------------------ snapshot immutability

    function test_Snapshot_PlanChangesDoNotAffectExistingSubscription() public {
        _setupMandate();
        vm.startPrank(merchant);
        mgr.setPlanPayout(planKey, payout2);
        mgr.setPlanActive(planKey, false);
        vm.stopPrank();
        _setLimit(500e6); // raised above the price: snapshot still unchanged
        RetempoSubscriptionManager.Subscription memory s = _sub(subKey);
        assertEq(s.amount, PRICE);
        assertEq(s.interval, INTERVAL);
        assertEq(s.grace, GRACE);
        assertEq(mgr.getPlan(planKey).amount, PRICE);
        // inactive plan does not stop billing of existing subscribers; the new payout is used
        vm.warp(T0 + INTERVAL);
        _charge(subKey);
        assertEq(usdc.balanceOf(payout2), PRICE);
        assertEq(usdc.balanceOf(payout), PRICE); // only the original subscribe payment
        vm.warp(T0 + 2 * INTERVAL);
        _renew(subKey);
        assertEq(usdc.balanceOf(payout2), 2 * PRICE);
        // ...but new subscribers cannot join an inactive plan
        vm.prank(customer2);
        vm.expectRevert(RetempoSubscriptionManager.PlanInactive.selector);
        mgr.subscribe(SREF, planKey, address(0));
    }

    function test_Snapshot_SecondPlanWithNewPriceDoesNotTouchOldSubscribers() public {
        (planKey, subKey) = _directSub();
        bytes32 plan2 = _plan(keccak256("plan-2"), 2 * PRICE, INTERVAL, 0, GRACE, 0);
        bytes32 sub2 = _subscribeAs(customer2, SREF, plan2);
        assertEq(_sub(subKey).amount, PRICE);
        assertEq(_sub(sub2).amount, 2 * PRICE);
    }

    function test_Snapshot_PaymentUsesCurrentPayoutNotSubscribeTimePayout() public {
        (planKey, subKey) = _directSub();
        vm.prank(merchant);
        mgr.setPlanPayout(planKey, payout2);
        vm.warp(T0 + INTERVAL);
        _renew(subKey);
        assertEq(usdc.balanceOf(payout2), PRICE);
    }
}
