// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {RetempoSubscriptionManager} from "../RetempoSubscriptionManager.sol";
import {ZeroAddress, Unauthorized, InvalidReference, AmountOutOfBounds} from "../interfaces/RetempoErrors.sol";
import {RetempoSystemBase} from "./helpers/RetempoSystemBase.sol";

/// @dev createPlan validation, the payment limit, and merchant plan administration.
contract RetempoSubscriptionManagerPlanTest is RetempoSystemBase {
    uint256 internal constant LAUNCH_LIMIT = 10_000e6;
    uint256 internal constant MINP = 10_000;

    function _cp(uint128 amount, uint32 interval, uint32 trial, uint32 grace, uint32 vest, address arbitrator)
        internal
        returns (bytes32)
    {
        vm.prank(merchant);
        return mgr.createPlan(PREF, payout, amount, interval, trial, grace, vest, arbitrator, false);
    }

    // ------------------------------------------------------------ happy path + event

    function test_CreatePlan_StoresTermsAndEmits() public {
        bytes32 key = mgr.planKey(merchant, PREF);
        vm.expectEmit(true, true, true, true, address(mgr));
        emit RetempoSubscriptionManager.PlanCreated(key, merchant, PREF, payout, PRICE, INTERVAL, 7 days, GRACE, VEST, arb, true);
        vm.prank(merchant);
        bytes32 got = mgr.createPlan(PREF, payout, PRICE, INTERVAL, 7 days, GRACE, VEST, arb, true);
        assertEq(got, key);
        RetempoSubscriptionManager.Plan memory p = mgr.getPlan(key);
        assertEq(p.merchant, merchant);
        assertEq(p.payout, payout);
        assertEq(p.amount, PRICE);
        assertEq(p.interval, INTERVAL);
        assertEq(p.trial, 7 days);
        assertEq(p.grace, GRACE);
        assertEq(p.vestDuration, VEST);
        assertEq(p.arbitrator, arb);
        assertTrue(p.customerMayRefundUnvested);
        assertTrue(p.active);
    }

    function test_CreatePlan_SameRefDifferentMerchantsAreIndependent() public {
        _directPlan();
        vm.prank(merchant2);
        bytes32 k2 = mgr.createPlan(PREF, payout2, PRICE, INTERVAL, 0, GRACE, 0, address(0), false);
        assertEq(k2, mgr.planKey(merchant2, PREF));
        assertNotEq(k2, mgr.planKey(merchant, PREF));
    }

    // ------------------------------------------------------------ validation reverts

    function test_CreatePlan_ZeroRefReverts() public {
        vm.prank(merchant);
        vm.expectRevert(InvalidReference.selector);
        mgr.createPlan(bytes32(0), payout, PRICE, INTERVAL, 0, GRACE, 0, address(0), false);
    }

    function test_CreatePlan_ZeroPayoutReverts() public {
        vm.prank(merchant);
        vm.expectRevert(ZeroAddress.selector);
        mgr.createPlan(PREF, address(0), PRICE, INTERVAL, 0, GRACE, 0, address(0), false);
    }

    function test_CreatePlan_AmountBelowMinReverts() public {
        uint128 bad = uint128(MINP) - 1;
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(AmountOutOfBounds.selector, uint256(bad), MINP, LAUNCH_LIMIT));
        mgr.createPlan(PREF, payout, bad, INTERVAL, 0, GRACE, 0, address(0), false);
    }

    function test_CreatePlan_ZeroAmountReverts() public {
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(AmountOutOfBounds.selector, 0, MINP, LAUNCH_LIMIT));
        mgr.createPlan(PREF, payout, 0, INTERVAL, 0, GRACE, 0, address(0), false);
    }

    function test_CreatePlan_MinAmountAccepted() public {
        bytes32 key = _cp(mgr.MIN_PAYMENT(), INTERVAL, 0, GRACE, 0, address(0));
        assertEq(mgr.getPlan(key).amount, mgr.MIN_PAYMENT());
    }

    function test_CreatePlan_IntervalBounds() public {
        vm.startPrank(merchant);
        vm.expectRevert(RetempoSubscriptionManager.InvalidInterval.selector);
        mgr.createPlan(PREF, payout, PRICE, 1 days - 1, 0, 0, 0, address(0), false);
        vm.expectRevert(RetempoSubscriptionManager.InvalidInterval.selector);
        mgr.createPlan(PREF, payout, PRICE, 366 days + 1, 0, 0, 0, address(0), false);
        vm.expectRevert(RetempoSubscriptionManager.InvalidInterval.selector);
        mgr.createPlan(PREF, payout, PRICE, 0, 0, 0, 0, address(0), false);
        // inclusive bounds accepted
        mgr.createPlan(PREF, payout, PRICE, 1 days, 0, 0, 0, address(0), false);
        mgr.createPlan(keccak256("b"), payout, PRICE, 366 days, 0, 365 days, 0, address(0), false);
        vm.stopPrank();
    }

    function test_CreatePlan_TrialBounds() public {
        vm.prank(merchant);
        vm.expectRevert(RetempoSubscriptionManager.InvalidTrial.selector);
        mgr.createPlan(PREF, payout, PRICE, INTERVAL, 365 days + 1, GRACE, 0, address(0), false);
        bytes32 key = _cp(PRICE, INTERVAL, 365 days, GRACE, 0, address(0));
        assertEq(mgr.getPlan(key).trial, 365 days);
    }

    function test_CreatePlan_GraceMustBeBelowInterval() public {
        vm.startPrank(merchant);
        vm.expectRevert(RetempoSubscriptionManager.InvalidGrace.selector);
        mgr.createPlan(PREF, payout, PRICE, INTERVAL, 0, INTERVAL, 0, address(0), false);
        vm.expectRevert(RetempoSubscriptionManager.InvalidGrace.selector);
        mgr.createPlan(PREF, payout, PRICE, INTERVAL, 0, INTERVAL + 1, 0, address(0), false);
        bytes32 key = mgr.createPlan(PREF, payout, PRICE, INTERVAL, 0, INTERVAL - 1, 0, address(0), false);
        vm.stopPrank();
        assertEq(mgr.getPlan(key).grace, INTERVAL - 1);
    }

    function test_CreatePlan_VestDurationBounds() public {
        vm.startPrank(merchant);
        vm.expectRevert(RetempoSubscriptionManager.InvalidVestDuration.selector);
        mgr.createPlan(PREF, payout, PRICE, INTERVAL, 0, GRACE, 1 hours - 1, arb, false);
        vm.expectRevert(RetempoSubscriptionManager.InvalidVestDuration.selector);
        mgr.createPlan(PREF, payout, PRICE, INTERVAL, 0, GRACE, 90 days + 1, arb, false);
        mgr.createPlan(PREF, payout, PRICE, INTERVAL, 0, GRACE, 1 hours, arb, false);
        mgr.createPlan(keccak256("b"), payout, PRICE, INTERVAL, 0, GRACE, 90 days, arb, false);
        vm.stopPrank();
    }

    function test_CreatePlan_VestingPlanNeedsNonZeroNonMerchantArbitrator() public {
        vm.startPrank(merchant);
        vm.expectRevert(RetempoSubscriptionManager.InvalidArbitrator.selector);
        mgr.createPlan(PREF, payout, PRICE, INTERVAL, 0, GRACE, VEST, address(0), false);
        vm.expectRevert(RetempoSubscriptionManager.InvalidArbitrator.selector);
        mgr.createPlan(PREF, payout, PRICE, INTERVAL, 0, GRACE, VEST, merchant, false);
        vm.stopPrank();
    }

    function test_CreatePlan_DuplicateKeyReverts() public {
        _directPlan();
        vm.prank(merchant);
        vm.expectRevert(RetempoSubscriptionManager.PlanExists.selector);
        mgr.createPlan(PREF, payout2, PRICE + 1, INTERVAL, 0, GRACE, 0, address(0), false);
        assertEq(mgr.getPlan(mgr.planKey(merchant, PREF)).amount, PRICE); // original untouched
    }

    function test_CreatePlan_WhilePausedReverts() public {
        _pauseMgr();
        vm.prank(merchant);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        mgr.createPlan(PREF, payout, PRICE, INTERVAL, 0, GRACE, 0, address(0), false);
    }

    /// @dev Documented behavior: arbitrator allowlisting is enforced by the escrow when funding, not at createPlan.
    function test_CreatePlan_NonAllowlistedArbitratorAcceptedButSubscribeFails() public {
        address rogue = makeAddr("rogueArb");
        bytes32 key = _cp(PRICE, INTERVAL, 0, GRACE, VEST, rogue);
        assertEq(mgr.getPlan(key).arbitrator, rogue);
        vm.prank(customer);
        vm.expectRevert(bytes4(keccak256("ArbitratorNotAllowed()")));
        mgr.subscribe(SREF, key, rogue);
    }

    // ------------------------------------------------------------ launch payment limit

    function test_Limit_LaunchValueIs10kUsdc() public view {
        assertEq(mgr.maxPaymentAmount(), LAUNCH_LIMIT);
    }

    function test_Limit_ExactlyLaunchLimitAccepted() public {
        bytes32 key = _cp(uint128(LAUNCH_LIMIT), INTERVAL, 0, GRACE, 0, address(0));
        assertEq(mgr.getPlan(key).amount, LAUNCH_LIMIT);
    }

    function test_Limit_OneAboveLaunchLimitReverts() public {
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(AmountOutOfBounds.selector, LAUNCH_LIMIT + 1, MINP, LAUNCH_LIMIT));
        mgr.createPlan(PREF, payout, uint128(LAUNCH_LIMIT + 1), INTERVAL, 0, GRACE, 0, address(0), false);
    }

    function test_Limit_LoweredAppliesToLaterPlans() public {
        _setLimit(50e6);
        bytes32 key = _cp(50e6, INTERVAL, 0, GRACE, 0, address(0));
        assertEq(mgr.getPlan(key).amount, 50e6);
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(AmountOutOfBounds.selector, 50e6 + 1, MINP, 50e6));
        mgr.createPlan(keccak256("two"), payout, 50e6 + 1, INTERVAL, 0, GRACE, 0, address(0), false);
    }

    function test_Limit_RaisedAppliesToLaterPlans() public {
        _setLimit(20_000e6);
        bytes32 key = _cp(20_000e6, INTERVAL, 0, GRACE, 0, address(0));
        assertEq(mgr.getPlan(key).amount, 20_000e6);
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(AmountOutOfBounds.selector, 20_000e6 + 1, MINP, 20_000e6));
        mgr.createPlan(keccak256("two"), payout, 20_000e6 + 1, INTERVAL, 0, GRACE, 0, address(0), false);
    }

    function test_Limit_LoweredBlocksNewSubscriptionsToExistingPlan() public {
        bytes32 key = _directPlan(); // PRICE = 100e6
        _setLimit(PRICE - 1);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(RetempoSubscriptionManager.PaymentLimitExceeded.selector, uint256(PRICE), uint256(PRICE - 1)));
        mgr.subscribe(SREF, key, address(0));
        _setLimit(PRICE); // exactly the price is fine
        bytes32 subKey = _subscribe(key);
        assertEq(_sub(subKey).chargeCount, 1);
    }

    function test_Limit_RaisedAllowsLargerDirectPayment() public {
        _setLimit(20_000e6);
        bytes32 key = _plan(PREF, 15_000e6, INTERVAL, 0, GRACE, 0);
        bytes32 subKey = _subscribe(key);
        assertEq(usdc.balanceOf(payout), 15_000e6);
        assertEq(_sub(subKey).chargeCount, 1);
    }

    /// @dev Raising the manager limit does not widen the escrow's own per-escrow maximum (10_000 USDC).
    function test_Limit_RaisedDoesNotBypassEscrowMaximum() public {
        _setLimit(20_000e6);
        bytes32 key = _plan(PREF, 15_000e6, INTERVAL, 0, GRACE, VEST);
        uint256 lo = escrow.minAmount();
        uint256 hi = escrow.maxEscrowAmount();
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(AmountOutOfBounds.selector, 15_000e6, lo, hi));
        mgr.subscribe(SREF, key, arb);
    }

    // ------------------------------------------------------------ setPlanActive

    function test_SetPlanActive_MerchantDeactivatesAndEmits() public {
        bytes32 key = _directPlan();
        vm.expectEmit(true, false, false, true, address(mgr));
        emit RetempoSubscriptionManager.PlanUpdated(key, false, payout);
        vm.prank(merchant);
        mgr.setPlanActive(key, false);
        assertFalse(mgr.getPlan(key).active);
        vm.prank(merchant);
        mgr.setPlanActive(key, true);
        assertTrue(mgr.getPlan(key).active);
    }

    function test_SetPlanActive_OnlyMerchant() public {
        bytes32 key = _directPlan();
        address[5] memory callers = [stranger, customer, admin, configMgr, merchant2];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Unauthorized.selector);
            mgr.setPlanActive(key, false);
        }
        assertTrue(mgr.getPlan(key).active);
    }

    function test_SetPlanActive_MissingPlanReverts() public {
        vm.prank(merchant);
        vm.expectRevert(RetempoSubscriptionManager.PlanMissing.selector);
        mgr.setPlanActive(keccak256("nope"), false);
    }

    function test_SetPlanActive_DeactivateAllowedWhilePausedActivateNot() public {
        bytes32 key = _directPlan();
        _pauseMgr();
        vm.prank(merchant);
        mgr.setPlanActive(key, false);
        assertFalse(mgr.getPlan(key).active);
        vm.prank(merchant);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        mgr.setPlanActive(key, true);
        assertFalse(mgr.getPlan(key).active);
    }

    // ------------------------------------------------------------ setPlanPayout

    function test_SetPlanPayout_UpdatesAndEmits() public {
        bytes32 key = _directPlan();
        vm.expectEmit(true, false, false, true, address(mgr));
        emit RetempoSubscriptionManager.PlanUpdated(key, true, payout2);
        vm.prank(merchant);
        mgr.setPlanPayout(key, payout2);
        assertEq(mgr.getPlan(key).payout, payout2);
    }

    function test_SetPlanPayout_ZeroReverts() public {
        bytes32 key = _directPlan();
        vm.prank(merchant);
        vm.expectRevert(ZeroAddress.selector);
        mgr.setPlanPayout(key, address(0));
    }

    function test_SetPlanPayout_OnlyMerchant() public {
        bytes32 key = _directPlan();
        address[5] memory callers = [stranger, customer, admin, pauser, merchant2];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Unauthorized.selector);
            mgr.setPlanPayout(key, callers[i]);
        }
        assertEq(mgr.getPlan(key).payout, payout);
    }

    function test_SetPlanPayout_MissingPlanReverts() public {
        vm.prank(merchant);
        vm.expectRevert(RetempoSubscriptionManager.PlanMissing.selector);
        mgr.setPlanPayout(keccak256("nope"), payout2);
    }

    function test_SetPlanPayout_WorksWhilePaused() public {
        bytes32 key = _directPlan();
        _pauseMgr();
        vm.prank(merchant);
        mgr.setPlanPayout(key, payout2);
        assertEq(mgr.getPlan(key).payout, payout2);
    }
}
