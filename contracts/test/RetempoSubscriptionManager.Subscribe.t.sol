// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {RetempoEscrow} from "../RetempoEscrow.sol";
import {RetempoSubscriptionManager} from "../RetempoSubscriptionManager.sol";
import {Unauthorized, InvalidReference} from "../interfaces/RetempoErrors.sol";
import {RetempoSystemBase} from "./helpers/RetempoSystemBase.sol";

/// @dev subscribe and manual renew.
contract RetempoSubscriptionManagerSubscribeTest is RetempoSystemBase {
    // ------------------------------------------------------------ subscribe: direct

    function test_Subscribe_DirectPlanPaysPayoutImmediately() public {
        bytes32 planKey = _directPlan();
        uint256 custBefore = usdc.balanceOf(customer);
        bytes32 subKey = _subscribe(planKey);
        assertEq(subKey, mgr.subscriptionKey(customer, SREF));
        assertEq(usdc.balanceOf(payout), PRICE);
        assertEq(usdc.balanceOf(customer), custBefore - PRICE);
        assertEq(usdc.balanceOf(address(mgr)), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        RetempoSubscriptionManager.Subscription memory s = _sub(subKey);
        assertEq(s.customer, customer);
        assertEq(s.planKey, planKey);
        assertEq(s.amount, PRICE);
        assertEq(s.interval, INTERVAL);
        assertEq(s.grace, GRACE);
        assertEq(s.nextChargeAt, T0 + INTERVAL);
        assertEq(s.chargeCount, 1);
        assertEq(s.acceptedArbitrator, address(0));
        assertEq(uint8(s.status), uint8(RetempoSubscriptionManager.SubStatus.Active));
    }

    function test_Subscribe_EmitsCreatedThenPaymentProcessed() public {
        bytes32 planKey = _directPlan();
        bytes32 subKey = mgr.subscriptionKey(customer, SREF);
        vm.expectEmit(true, true, true, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionCreated(subKey, planKey, customer, SREF, PRICE, INTERVAL, uint40(T0), address(0));
        vm.expectEmit(true, true, true, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionPaymentProcessed(
            subKey, planKey, customer, 1, merchant, PRICE, RetempoSubscriptionManager.PaymentTrigger.Manual, bytes32(0), uint40(T0), uint40(T0 + INTERVAL), false
        );
        _subscribe(planKey);
    }

    // ------------------------------------------------------------ subscribe: trial

    function test_Subscribe_TrialChargesNothingAndSetsNextChargeAt() public {
        bytes32 planKey = _trialPlan(7 days);
        uint256 custBefore = usdc.balanceOf(customer);
        bytes32 subKey = mgr.subscriptionKey(customer, SREF);
        vm.expectEmit(true, true, true, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionCreated(subKey, planKey, customer, SREF, PRICE, INTERVAL, uint40(T0 + 7 days), address(0));
        _subscribe(planKey);
        assertEq(usdc.balanceOf(customer), custBefore);
        assertEq(usdc.balanceOf(payout), 0);
        assertEq(_sub(subKey).nextChargeAt, T0 + 7 days);
        assertEq(_sub(subKey).chargeCount, 0);
    }

    function test_Subscribe_TrialFirstChargeDueExactlyAtTrialEnd() public {
        bytes32 subKey = _subscribe(_trialPlan(7 days));
        vm.warp(T0 + 7 days - 1);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        mgr.renew(subKey);
        vm.warp(T0 + 7 days);
        _renew(subKey);
        assertEq(usdc.balanceOf(payout), PRICE);
        assertEq(_sub(subKey).nextChargeAt, T0 + 7 days + INTERVAL);
        assertEq(_sub(subKey).chargeCount, 1);
    }

    // ------------------------------------------------------------ subscribe: escrow plan

    function test_Subscribe_EscrowPlanFundsEscrowAndLinksKey() public {
        bytes32 planKey = _escrowPlan();
        bytes32 subKey = mgr.subscriptionKey(customer, SREF);
        bytes32 rk = _routedKey(merchant, subKey, 1);
        vm.expectEmit(true, true, true, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionCreated(subKey, planKey, customer, SREF, PRICE, INTERVAL, uint40(T0), arb);
        vm.expectEmit(true, true, true, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionPaymentProcessed(
            subKey, planKey, customer, 1, merchant, PRICE, RetempoSubscriptionManager.PaymentTrigger.Manual, rk, uint40(T0), uint40(T0 + INTERVAL), false
        );
        _subscribe(planKey);
        assertEq(escrow.escrowKey(merchant, _invoiceRef(subKey, 1)), rk);
        RetempoEscrow.Escrow memory e = escrow.getEscrow(rk);
        assertEq(e.merchant, merchant);
        assertEq(e.customer, customer);
        assertEq(e.arbitrator, arb);
        assertEq(e.amount, PRICE);
        assertEq(e.vestDuration, VEST);
        assertEq(e.vestStart, T0);
        assertEq(uint8(e.status), uint8(RetempoEscrow.Status.Active));
        // funds sit in escrow only; manager keeps nothing and holds no escrow allowance
        assertEq(usdc.balanceOf(address(escrow)), PRICE);
        assertEq(usdc.balanceOf(address(mgr)), 0);
        assertEq(usdc.balanceOf(payout), 0);
        assertEq(usdc.allowance(address(mgr), address(escrow)), 0);
        assertEq(_sub(subKey).acceptedArbitrator, arb);
    }

    function test_Subscribe_EscrowPlanRequiresExactArbitrator() public {
        bytes32 planKey = _escrowPlan();
        address[3] memory wrong = [address(0), arb2, stranger];
        for (uint256 i; i < wrong.length; ++i) {
            vm.prank(customer);
            vm.expectRevert(RetempoSubscriptionManager.ArbitratorNotAccepted.selector);
            mgr.subscribe(SREF, planKey, wrong[i]);
        }
        assertEq(uint8(_sub(mgr.subscriptionKey(customer, SREF)).status), 0);
    }

    function test_Subscribe_DirectPlanRequiresZeroArbitrator() public {
        bytes32 planKey = _directPlan();
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.ArbitratorNotAccepted.selector);
        mgr.subscribe(SREF, planKey, arb);
    }

    // ------------------------------------------------------------ subscribe: reverts

    function test_Subscribe_ZeroRefReverts() public {
        bytes32 planKey = _directPlan();
        vm.prank(customer);
        vm.expectRevert(InvalidReference.selector);
        mgr.subscribe(bytes32(0), planKey, address(0));
    }

    function test_Subscribe_MissingPlanReverts() public {
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.PlanMissing.selector);
        mgr.subscribe(SREF, keccak256("none"), address(0));
    }

    function test_Subscribe_InactivePlanReverts() public {
        bytes32 planKey = _directPlan();
        vm.prank(merchant);
        mgr.setPlanActive(planKey, false);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.PlanInactive.selector);
        mgr.subscribe(SREF, planKey, address(0));
    }

    function test_Subscribe_MerchantCannotSubscribeToOwnPlan() public {
        bytes32 planKey = _directPlan();
        usdc.mint(merchant, CUSTOMER_FUNDS);
        _approveMgr(merchant);
        vm.prank(merchant);
        vm.expectRevert(Unauthorized.selector);
        mgr.subscribe(SREF, planKey, address(0));
    }

    function test_Subscribe_DuplicateKeyReverts() public {
        bytes32 planKey = _directPlan();
        bytes32 subKey = _subscribe(planKey);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionExists.selector);
        mgr.subscribe(SREF, planKey, address(0));
        assertEq(_sub(subKey).chargeCount, 1);
        assertEq(usdc.balanceOf(payout), PRICE);
    }

    function test_Subscribe_CanceledKeyCannotBeReused() public {
        bytes32 planKey = _directPlan();
        bytes32 subKey = _subscribe(planKey);
        vm.prank(customer);
        mgr.cancelSubscription(subKey);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionExists.selector);
        mgr.subscribe(SREF, planKey, address(0));
    }

    function test_Subscribe_SameRefDifferentCustomersIndependent() public {
        bytes32 planKey = _directPlan();
        bytes32 k1 = _subscribe(planKey);
        bytes32 k2 = _subscribeAs(customer2, SREF, planKey);
        assertNotEq(k1, k2);
        assertEq(usdc.balanceOf(payout), 2 * PRICE);
    }

    function test_Subscribe_WhilePausedReverts() public {
        bytes32 planKey = _directPlan();
        _pauseMgr();
        vm.prank(customer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        mgr.subscribe(SREF, planKey, address(0));
    }

    function test_Subscribe_InsufficientAllowanceReverts() public {
        bytes32 planKey = _directPlan();
        vm.prank(customer);
        usdc.approve(address(mgr), PRICE - 1);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(RetempoSubscriptionManager.InsufficientAllowance.selector, customer, uint256(PRICE), uint256(PRICE - 1)));
        mgr.subscribe(SREF, planKey, address(0));
        assertEq(uint8(_sub(mgr.subscriptionKey(customer, SREF)).status), 0); // nothing recorded
    }

    function test_Subscribe_InsufficientBalanceReverts() public {
        bytes32 planKey = _directPlan();
        address poor = makeAddr("poor");
        usdc.mint(poor, PRICE - 1);
        _approveMgr(poor);
        vm.prank(poor);
        vm.expectRevert(abi.encodeWithSelector(RetempoSubscriptionManager.InsufficientBalance.selector, poor, uint256(PRICE), uint256(PRICE - 1)));
        mgr.subscribe(SREF, planKey, address(0));
    }

    function test_Subscribe_ExactBalanceAndAllowanceSucceeds() public {
        bytes32 planKey = _directPlan();
        address exact = makeAddr("exact");
        usdc.mint(exact, PRICE);
        vm.prank(exact);
        usdc.approve(address(mgr), PRICE);
        vm.prank(exact);
        mgr.subscribe(SREF, planKey, address(0));
        assertEq(usdc.balanceOf(exact), 0);
        assertEq(usdc.balanceOf(payout), PRICE);
    }

    // ------------------------------------------------------------ renew

    function test_Renew_OnlyCustomer() public {
        (, bytes32 subKey) = _directSub();
        vm.warp(T0 + INTERVAL);
        address[5] memory callers = [stranger, merchant, admin, pauser, merchant2];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Unauthorized.selector);
            mgr.renew(subKey);
        }
        vm.prank(customer2); // another subscriber is not this subscription's customer
        vm.expectRevert(Unauthorized.selector);
        mgr.renew(subKey);
        assertEq(_sub(subKey).chargeCount, 1);
    }

    function test_Renew_UnknownSubscriptionReverts() public {
        vm.prank(customer);
        vm.expectRevert(Unauthorized.selector);
        mgr.renew(keccak256("unknown"));
    }

    function test_Renew_NotDueReverts() public {
        (, bytes32 subKey) = _directSub();
        vm.warp(T0 + INTERVAL - 1);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        mgr.renew(subKey);
        assertEq(usdc.balanceOf(payout), PRICE);
    }

    function test_Renew_DueExactlyAtNextChargeAtPreservesCadence() public {
        (bytes32 planKey, bytes32 subKey) = _directSub();
        vm.warp(T0 + INTERVAL);
        vm.expectEmit(true, true, true, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionPaymentProcessed(
            subKey, planKey, customer, 2, merchant, PRICE, RetempoSubscriptionManager.PaymentTrigger.Manual, bytes32(0), uint40(T0 + INTERVAL), uint40(T0 + 2 * INTERVAL), false
        );
        _renew(subKey);
        assertEq(usdc.balanceOf(payout), 2 * PRICE);
        assertEq(_sub(subKey).nextChargeAt, T0 + 2 * INTERVAL);
        assertEq(_sub(subKey).chargeCount, 2);
    }

    function test_Renew_LateWithinGraceKeepsCadence_BoundaryInclusive() public {
        (, bytes32 subKey) = _directSub();
        vm.warp(T0 + INTERVAL + GRACE); // exactly nextChargeAt + grace -> not rebased
        _renew(subKey);
        assertEq(_sub(subKey).nextChargeAt, T0 + 2 * INTERVAL);
    }

    function test_Renew_OneSecondPastGraceRebases() public {
        (bytes32 planKey, bytes32 subKey) = _directSub();
        uint256 t = T0 + INTERVAL + GRACE + 1;
        vm.warp(t);
        vm.expectEmit(true, true, true, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionPaymentProcessed(
            subKey, planKey, customer, 2, merchant, PRICE, RetempoSubscriptionManager.PaymentTrigger.Manual, bytes32(0), uint40(t), uint40(t + INTERVAL), true
        );
        _renew(subKey);
        assertEq(_sub(subKey).nextChargeAt, t + INTERVAL);
    }

    function test_Renew_EscrowPlanCreatesNewEscrowPerPeriod() public {
        (, bytes32 subKey) = _escrowSub();
        vm.warp(T0 + INTERVAL);
        _renew(subKey);
        RetempoEscrow.Escrow memory e1 = escrow.getEscrow(_routedKey(merchant, subKey, 1));
        RetempoEscrow.Escrow memory e2 = escrow.getEscrow(_routedKey(merchant, subKey, 2));
        assertEq(e1.amount, PRICE);
        assertEq(e2.amount, PRICE);
        assertEq(e2.vestStart, T0 + INTERVAL);
        assertEq(usdc.balanceOf(address(escrow)), 2 * PRICE);
        assertEq(usdc.balanceOf(address(mgr)), 0);
    }

    function test_Renew_CanceledReverts() public {
        (, bytes32 subKey) = _directSub();
        vm.prank(customer);
        mgr.cancelSubscription(subKey);
        vm.warp(T0 + INTERVAL);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionInactive.selector);
        mgr.renew(subKey);
    }

    function test_Renew_WhilePausedReverts() public {
        (, bytes32 subKey) = _directSub();
        vm.warp(T0 + INTERVAL);
        _pauseMgr();
        vm.prank(customer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        mgr.renew(subKey);
    }

    function test_Renew_InsufficientAllowanceAndBalance() public {
        (, bytes32 subKey) = _directSub();
        vm.warp(T0 + INTERVAL);
        vm.prank(customer);
        usdc.approve(address(mgr), PRICE - 1);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(RetempoSubscriptionManager.InsufficientAllowance.selector, customer, uint256(PRICE), uint256(PRICE - 1)));
        mgr.renew(subKey);
        vm.prank(customer);
        usdc.approve(address(mgr), type(uint256).max);
        uint256 bal = usdc.balanceOf(customer);
        vm.prank(customer);
        usdc.transfer(stranger, bal - (PRICE - 1));
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(RetempoSubscriptionManager.InsufficientBalance.selector, customer, uint256(PRICE), uint256(PRICE - 1)));
        mgr.renew(subKey);
    }
}
