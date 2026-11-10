// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Unauthorized} from "../interfaces/RetempoErrors.sol";
import {RetempoSubscriptionManager} from "../RetempoSubscriptionManager.sol";
import {RetempoSystemBase} from "./helpers/RetempoSystemBase.sol";

/// @dev createMandate validation, the seven recurring-charge checks and canCharge reason codes.
contract RetempoSubscriptionManagerMandateTest is RetempoSystemBase {
    uint256 internal constant MAND_SLOT = 6; // `mandates` mapping slot (forge inspect storage-layout)

    bytes32 internal subKey;

    // ------------------------------------------------------------ helpers

    /// @dev Direct sub paid at T0, long mandate (per PRICE, total `total`), clock at the first due time.
    function _ready(uint128 total) internal {
        (, subKey) = _directSub();
        _mandate(subKey, PRICE, total, T0 + 300 days);
        vm.warp(T0 + INTERVAL);
    }

    function _expectReason(uint8 r) internal view {
        (bool ok, uint8 got) = mgr.canCharge(subKey);
        assertEq(got, r, "canCharge reason");
        assertEq(ok, r == 0, "canCharge ok flag");
    }

    function _approveExact(uint256 amt) internal {
        vm.prank(customer);
        usdc.approve(address(mgr), amt);
    }

    function _leaveBalance(uint256 keep) internal {
        uint256 bal = usdc.balanceOf(customer);
        vm.prank(customer);
        usdc.transfer(stranger, bal - keep);
    }

    function _expectNoStateChange(uint256 payoutBefore, uint32 countBefore, uint40 dueBefore, uint128 spentBefore) internal view {
        assertEq(usdc.balanceOf(payout), payoutBefore);
        assertEq(_sub(subKey).chargeCount, countBefore);
        assertEq(_sub(subKey).nextChargeAt, dueBefore);
        assertEq(_man(subKey).spent, spentBefore);
    }

    // ------------------------------------------------------------ createMandate

    function test_CreateMandate_StoresAndEmits() public {
        (, subKey) = _directSub();
        uint40 exp = uint40(T0 + 90 days);
        vm.expectEmit(true, true, false, true, address(mgr));
        emit RetempoSubscriptionManager.MandateCreated(subKey, customer, 1, PRICE, 3 * PRICE, exp);
        _mandate(subKey, PRICE, 3 * PRICE, exp);
        RetempoSubscriptionManager.Mandate memory m = _man(subKey);
        assertEq(m.perChargeCap, PRICE);
        assertEq(m.totalCap, 3 * PRICE);
        assertEq(m.spent, 0);
        assertEq(m.expiry, exp);
        assertEq(m.nonce, 1);
        assertTrue(m.active);
    }

    function test_CreateMandate_OnlyCustomer() public {
        (, subKey) = _directSub();
        address[4] memory callers = [stranger, merchant, admin, customer2];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Unauthorized.selector);
            mgr.createMandate(subKey, PRICE, PRICE, uint40(T0 + 1 days));
        }
        vm.prank(customer);
        vm.expectRevert(Unauthorized.selector);
        mgr.createMandate(keccak256("unknown"), PRICE, PRICE, uint40(T0 + 1 days)); // missing sub: customer is zero
    }

    function test_CreateMandate_CanceledSubscriptionReverts() public {
        (, subKey) = _directSub();
        vm.prank(customer);
        mgr.cancelSubscription(subKey);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionInactive.selector);
        mgr.createMandate(subKey, PRICE, PRICE, uint40(T0 + 1 days));
    }

    function test_CreateMandate_PerChargeCapBelowPriceReverts() public {
        (, subKey) = _directSub();
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.InvalidMandateCaps.selector);
        mgr.createMandate(subKey, PRICE - 1, PRICE, uint40(T0 + 1 days));
        _mandate(subKey, PRICE, PRICE, T0 + 1 days); // exactly the price is fine
        assertTrue(_man(subKey).active);
    }

    function test_CreateMandate_TotalCapBelowPerChargeReverts() public {
        (, subKey) = _directSub();
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.InvalidMandateCaps.selector);
        mgr.createMandate(subKey, 2 * PRICE, 2 * PRICE - 1, uint40(T0 + 1 days));
        _mandate(subKey, 2 * PRICE, 2 * PRICE, T0 + 1 days);
        assertTrue(_man(subKey).active);
    }

    function test_CreateMandate_TotalCapAboveHardMaxReverts() public {
        (, subKey) = _directSub();
        uint128 hardMax = uint128(mgr.HARD_MAX_AMOUNT());
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.InvalidMandateCaps.selector);
        mgr.createMandate(subKey, PRICE, hardMax + 1, uint40(T0 + 1 days));
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.InvalidMandateCaps.selector);
        mgr.createMandate(subKey, PRICE, type(uint128).max, uint40(T0 + 1 days));
        _mandate(subKey, PRICE, hardMax, T0 + 1 days);
        assertEq(_man(subKey).totalCap, hardMax);
    }

    function test_CreateMandate_ExpiryBounds() public {
        (, subKey) = _directSub();
        uint256 maxDur = mgr.MAX_MANDATE_DURATION();
        uint256[4] memory bad = [uint256(0), T0 - 1, T0, T0 + maxDur + 1]; // zero, past, now (exclusive), too far
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(customer);
            vm.expectRevert(RetempoSubscriptionManager.InvalidExpiry.selector);
            mgr.createMandate(subKey, PRICE, PRICE, uint40(bad[i]));
        }
        _mandate(subKey, PRICE, PRICE, T0 + 1); // one second in the future
        assertEq(_man(subKey).expiry, T0 + 1);
        _mandate(subKey, PRICE, PRICE, T0 + maxDur); // exactly MAX_MANDATE_DURATION is accepted (inclusive)
        assertEq(_man(subKey).expiry, T0 + maxDur);
        assertEq(_man(subKey).nonce, 2);
    }

    function test_CreateMandate_WhilePausedReverts() public {
        (, subKey) = _directSub();
        _pauseMgr();
        vm.prank(customer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        mgr.createMandate(subKey, PRICE, PRICE, uint40(T0 + 1 days));
    }

    function test_CreateMandate_ReplacingResetsSpentBumpsNonceAndEmitsRevoked() public {
        _ready(3 * PRICE);
        _charge(subKey);
        assertEq(_man(subKey).spent, PRICE);
        uint40 exp = uint40(block.timestamp + 40 days);
        vm.expectEmit(true, true, false, true, address(mgr));
        emit RetempoSubscriptionManager.MandateRevoked(subKey, customer, 1, 2);
        vm.expectEmit(true, true, false, true, address(mgr));
        emit RetempoSubscriptionManager.MandateCreated(subKey, customer, 2, 2 * PRICE, 5 * PRICE, exp);
        _mandate(subKey, 2 * PRICE, 5 * PRICE, exp);
        RetempoSubscriptionManager.Mandate memory m = _man(subKey);
        assertEq(m.spent, 0);
        assertEq(m.nonce, 2);
        assertEq(m.perChargeCap, 2 * PRICE);
        assertEq(m.totalCap, 5 * PRICE);
        assertTrue(m.active);
    }

    function test_CreateMandate_ReplacingInactiveEmitsNoRevoked() public {
        (, subKey) = _directSub();
        _stdMandate(subKey);
        vm.prank(customer);
        mgr.revokeMandate(subKey);
        vm.recordLogs();
        _stdMandate(subKey);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "only MandateCreated");
        assertEq(logs[0].topics[0], RetempoSubscriptionManager.MandateCreated.selector);
        assertEq(_man(subKey).nonce, 2);
    }

    // ------------------------------------------------------------ charge: success

    function test_Charge_SucceedsForAnyCaller() public {
        _ready(3 * PRICE);
        address[5] memory callers = [stranger, merchant, customer, admin, address(this)];
        for (uint256 i; i < callers.length; ++i) {
            uint256 snap = vm.snapshotState();
            vm.prank(callers[i]);
            mgr.charge(subKey);
            assertEq(_sub(subKey).chargeCount, 2);
            assertEq(usdc.balanceOf(payout), 2 * PRICE);
            vm.revertToState(snap);
        }
    }

    function test_Charge_UpdatesStateAndEmitsRecurringEvent() public {
        _ready(3 * PRICE);
        bytes32 planKey = _sub(subKey).planKey;
        vm.expectEmit(true, true, true, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionPaymentProcessed(
            subKey, planKey, customer, 2, merchant, PRICE, RetempoSubscriptionManager.PaymentTrigger.Recurring, bytes32(0), uint40(T0 + INTERVAL), uint40(T0 + 2 * INTERVAL), false
        );
        _charge(subKey);
        assertEq(_man(subKey).spent, PRICE);
        assertEq(_sub(subKey).nextChargeAt, T0 + 2 * INTERVAL);
        assertEq(usdc.balanceOf(payout), 2 * PRICE);
        _expectReason(5); // already paid this period
    }

    function test_Charge_EscrowPlanRoutesToEscrow() public {
        (, subKey) = _escrowSub();
        _mandate(subKey, PRICE, 3 * PRICE, T0 + 300 days);
        vm.warp(T0 + INTERVAL);
        bytes32 rk = _routedKey(merchant, subKey, 2);
        bytes32 pk = _sub(subKey).planKey;
        vm.expectEmit(true, true, true, true, address(mgr));
        emit RetempoSubscriptionManager.SubscriptionPaymentProcessed(
            subKey, pk, customer, 2, merchant, PRICE, RetempoSubscriptionManager.PaymentTrigger.Recurring, rk, uint40(T0 + INTERVAL), uint40(T0 + 2 * INTERVAL), false
        );
        _charge(subKey);
        assertEq(escrow.getEscrow(rk).amount, PRICE);
        assertEq(usdc.balanceOf(address(escrow)), 2 * PRICE);
        assertEq(usdc.balanceOf(address(mgr)), 0);
        assertEq(usdc.allowance(address(mgr), address(escrow)), 0);
    }

    // ------------------------------------------------------------ the seven checks, one test each

    function test_Charge_NoMandateReverts() public {
        (, subKey) = _directSub();
        vm.warp(T0 + INTERVAL);
        _expectReason(6);
        vm.expectRevert(RetempoSubscriptionManager.MandateMissing.selector);
        _charge(subKey);
    }

    function test_Charge_RevokedMandateReverts() public {
        _ready(3 * PRICE);
        vm.prank(customer);
        mgr.revokeMandate(subKey);
        _expectReason(7);
        vm.expectRevert(RetempoSubscriptionManager.MandateInactive.selector);
        _charge(subKey);
    }

    function test_Charge_OneSecondBeforeExpirySucceeds() public {
        (, subKey) = _directSub();
        _mandate(subKey, PRICE, 3 * PRICE, T0 + INTERVAL + 1); // expiry = due time + 1
        vm.warp(T0 + INTERVAL);
        _expectReason(0);
        _charge(subKey);
        assertEq(_man(subKey).spent, PRICE);
    }

    function test_Charge_ExactlyAtExpiryIsRejected() public {
        (, subKey) = _directSub();
        _mandate(subKey, PRICE, 3 * PRICE, T0 + INTERVAL + 1);
        vm.warp(T0 + INTERVAL + 1); // block.timestamp == expiry
        _expectReason(8);
        vm.expectRevert(RetempoSubscriptionManager.MandateExpired.selector);
        _charge(subKey);
        vm.warp(T0 + INTERVAL + 100); // well past expiry
        vm.expectRevert(RetempoSubscriptionManager.MandateExpired.selector);
        _charge(subKey);
    }

    function test_Charge_ExpiryEqualToDueTimeIsRejected() public {
        (, subKey) = _directSub();
        _mandate(subKey, PRICE, 3 * PRICE, T0 + INTERVAL);
        vm.warp(T0 + INTERVAL);
        vm.expectRevert(RetempoSubscriptionManager.MandateExpired.selector);
        _charge(subKey);
    }

    /// @dev amount > perChargeCap cannot be produced through the public API (the cap is validated >= price and the
    ///      price snapshot is immutable), so the guard is exercised by lowering the cap slot directly.
    function test_Charge_AmountAbovePerChargeCapReverts_StoragePoke() public {
        _ready(3 * PRICE);
        bytes32 slot0 = keccak256(abi.encode(subKey, MAND_SLOT));
        bytes32 cur = vm.load(address(mgr), slot0);
        uint256 hiHalf = uint256(cur) >> 128;
        vm.store(address(mgr), slot0, bytes32((hiHalf << 128) | uint256(PRICE - 1)));
        assertEq(_man(subKey).perChargeCap, PRICE - 1);
        assertEq(_man(subKey).totalCap, 3 * PRICE);
        _expectReason(9);
        vm.expectRevert(RetempoSubscriptionManager.PerChargeCapExceeded.selector);
        _charge(subKey);
    }

    function test_Charge_TotalCapExactBoundary() public {
        _ready(2 * PRICE);
        _charge(subKey); // spent = PRICE
        vm.warp(T0 + 2 * INTERVAL);
        _expectReason(0);
        _charge(subKey); // spent == totalCap exactly
        assertEq(_man(subKey).spent, 2 * PRICE);
        vm.warp(T0 + 3 * INTERVAL);
        _expectReason(10);
        uint256 payoutBefore = usdc.balanceOf(payout);
        uint32 cnt = _sub(subKey).chargeCount;
        uint40 due = _sub(subKey).nextChargeAt;
        vm.expectRevert(RetempoSubscriptionManager.TotalCapExceeded.selector);
        _charge(subKey);
        _expectNoStateChange(payoutBefore, cnt, due, 2 * PRICE);
    }

    function test_Charge_TotalCapOneUnitShortRejectsSecondCharge() public {
        _ready(2 * PRICE - 1);
        _charge(subKey);
        vm.warp(T0 + 2 * INTERVAL);
        _expectReason(10);
        vm.expectRevert(RetempoSubscriptionManager.TotalCapExceeded.selector);
        _charge(subKey);
        assertEq(_man(subKey).spent, PRICE);
    }

    function test_Charge_AllowanceOneUnitShortReverts() public {
        _ready(3 * PRICE);
        _approveExact(PRICE - 1);
        _expectReason(11);
        vm.expectRevert(abi.encodeWithSelector(RetempoSubscriptionManager.InsufficientAllowance.selector, customer, uint256(PRICE), uint256(PRICE - 1)));
        _charge(subKey);
        _approveExact(PRICE); // exactly enough
        _expectReason(0);
        _charge(subKey);
        assertEq(usdc.allowance(customer, address(mgr)), 0);
    }

    function test_Charge_BalanceOneUnitShortReverts() public {
        _ready(3 * PRICE);
        _leaveBalance(PRICE - 1);
        _expectReason(12);
        vm.expectRevert(abi.encodeWithSelector(RetempoSubscriptionManager.InsufficientBalance.selector, customer, uint256(PRICE), uint256(PRICE - 1)));
        _charge(subKey);
        usdc.mint(customer, 1); // exactly PRICE
        _expectReason(0);
        _charge(subKey);
        assertEq(usdc.balanceOf(customer), 0);
    }

    function test_Charge_NotDueReverts() public {
        _ready(3 * PRICE);
        vm.warp(T0 + INTERVAL - 1);
        _expectReason(5);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        _charge(subKey);
    }

    function test_Charge_CanceledSubscriptionReverts() public {
        _ready(3 * PRICE);
        vm.prank(merchant);
        mgr.cancelSubscription(subKey);
        _expectReason(1);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionInactive.selector);
        _charge(subKey);
    }

    function test_Charge_UnknownSubscriptionReverts() public {
        subKey = keccak256("unknown");
        _expectReason(1);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionInactive.selector);
        _charge(subKey);
    }

    function test_Charge_AmountAboveLoweredLimitReverts() public {
        _ready(3 * PRICE);
        _setLimit(PRICE - 1);
        _expectReason(3);
        vm.expectRevert(abi.encodeWithSelector(RetempoSubscriptionManager.PaymentLimitExceeded.selector, uint256(PRICE), uint256(PRICE - 1)));
        _charge(subKey);
        _setLimit(PRICE); // exactly the price is within the limit
        _expectReason(0);
        _charge(subKey);
    }

    function test_Charge_WhilePausedReverts_CanChargeIgnoresPause() public {
        _ready(3 * PRICE);
        _pauseMgr();
        _expectReason(0); // documented: pause is not simulated
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _charge(subKey);
    }

    // ------------------------------------------------------------ canCharge ordering

    function test_CanCharge_Order_SubscriptionBeforeEverything() public {
        _ready(3 * PRICE);
        vm.prank(customer);
        mgr.cancelSubscription(subKey);
        _setLimit(PRICE - 1);
        _expectReason(1); // canceled beats limit
    }

    function test_CanCharge_Order_LimitBeforeNotDue() public {
        _ready(3 * PRICE);
        vm.warp(T0 + 1 days);
        _setLimit(PRICE - 1);
        _expectReason(3);
    }

    function test_CanCharge_Order_NotDueBeforeMandate() public {
        (, subKey) = _directSub(); // no mandate and not due
        _expectReason(5);
    }

    function test_CanCharge_Order_MandateMissingBeforeAllowance() public {
        (, subKey) = _directSub();
        vm.warp(T0 + INTERVAL);
        _approveExact(0);
        _expectReason(6);
    }

    function test_CanCharge_Order_RevokedBeforeExpired() public {
        (, subKey) = _directSub();
        _mandate(subKey, PRICE, PRICE, T0 + INTERVAL + 1);
        vm.prank(customer);
        mgr.revokeMandate(subKey);
        vm.warp(T0 + INTERVAL + 1);
        _expectReason(7);
    }

    function test_CanCharge_Order_ExpiredBeforeAllowance() public {
        (, subKey) = _directSub();
        _mandate(subKey, PRICE, PRICE, T0 + INTERVAL + 1);
        vm.warp(T0 + INTERVAL + 1);
        _approveExact(0);
        _expectReason(8);
    }

    function test_CanCharge_Order_TotalCapBeforeAllowance() public {
        _ready(PRICE);
        _charge(subKey);
        vm.warp(T0 + 2 * INTERVAL);
        _approveExact(0);
        _expectReason(10);
    }

    function test_CanCharge_Order_AllowanceBeforeBalance() public {
        _ready(3 * PRICE);
        _approveExact(0);
        _leaveBalance(0);
        _expectReason(11);
    }

    function test_CanCharge_OkWhenAllChecksPass() public {
        _ready(3 * PRICE);
        _expectReason(0);
    }
}
