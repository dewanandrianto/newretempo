// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RetempoSubscriptionManager} from "../RetempoSubscriptionManager.sol";
import {Unauthorized, DepositMismatch} from "../interfaces/RetempoErrors.sol";
import {RetempoSystemBase} from "./helpers/RetempoSystemBase.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";

/// @dev Hostile / non-standard token behavior around payment execution.
contract RetempoSubscriptionManagerReentrancyTest is RetempoSystemBase {
    ReentrantToken internal tok;
    bytes32 internal subKey;

    function setUp() public override {
        vm.warp(T0);
        tok = new ReentrantToken();
        _wire(address(tok));
        tok.mint(customer, CUSTOMER_FUNDS);
        vm.prank(customer);
        tok.approve(address(mgr), type(uint256).max);
        subKey = mgr.subscriptionKey(customer, SREF);
    }

    function _payloads() internal view returns (bytes[6] memory p, bytes4[6] memory errs) {
        bytes4 rg = ReentrancyGuard.ReentrancyGuardReentrantCall.selector;
        p[0] = abi.encodeCall(mgr.subscribe, (keccak256("other"), mgr.planKey(merchant, PREF), address(0)));
        p[1] = abi.encodeCall(mgr.renew, (subKey));
        p[2] = abi.encodeCall(mgr.charge, (subKey));
        p[3] = abi.encodeCall(mgr.cancelSubscription, (subKey));
        p[4] = abi.encodeCall(mgr.createMandate, (subKey, PRICE, PRICE, uint40(T0 + 1 days)));
        p[5] = abi.encodeCall(mgr.revokeMandate, (subKey));
        // guarded entry points hit the reentrancy guard; unguarded ones are caller-gated (token is not a party)
        errs = [rg, rg, rg, Unauthorized.selector, Unauthorized.selector, Unauthorized.selector];
    }

    function _assertBlocked() internal view {
        assertTrue(tok.attacked(), "hook fired");
        assertFalse(tok.attackSucceeded(), "reentrant call must fail");
    }

    // ---------------------------------------------------- reentry during subscribe (first payment)

    function _subscribeUnderAttack(bool escrowPlan, bool before_) internal {
        (bytes[6] memory p, bytes4[6] memory errs) = _payloads();
        bytes32 planKey = escrowPlan ? _escrowPlan() : _directPlan();
        for (uint256 i; i < p.length; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 custBefore = tok.balanceOf(customer);
            tok.arm(ReentrantToken.Hook.TransferFrom, address(mgr), p[i], before_);
            address acc = _accepted(planKey);
            vm.prank(customer);
            mgr.subscribe(SREF, planKey, acc);
            _assertBlocked();
            assertEq(bytes4(tok.attackReturn()), errs[i], "revert selector");
            // outer subscribe is intact: exactly one payment, exactly one record
            assertEq(_sub(subKey).chargeCount, 1);
            assertEq(_sub(subKey).nextChargeAt, T0 + INTERVAL);
            assertEq(uint8(_sub(subKey).status), uint8(RetempoSubscriptionManager.SubStatus.Active));
            assertEq(tok.balanceOf(customer), custBefore - PRICE);
            assertEq(tok.balanceOf(address(mgr)), 0);
            assertFalse(_man(subKey).active);
            if (escrowPlan) {
                assertEq(tok.balanceOf(address(escrow)), PRICE);
                assertEq(tok.balanceOf(payout), 0);
            } else {
                assertEq(tok.balanceOf(payout), PRICE);
            }
            vm.revertToState(snap);
        }
    }

    function test_Reentrancy_SubscribeDirect_HookBeforeTransfer() public {
        _subscribeUnderAttack(false, true);
    }

    function test_Reentrancy_SubscribeDirect_HookAfterTransfer() public {
        _subscribeUnderAttack(false, false);
    }

    function test_Reentrancy_SubscribeEscrow_HookBeforeTransfer() public {
        _subscribeUnderAttack(true, true);
    }

    function test_Reentrancy_SubscribeEscrow_HookAfterTransfer() public {
        _subscribeUnderAttack(true, false);
    }

    // ---------------------------------------------------- reentry during charge / renew

    function _paymentUnderAttack(bool viaCharge, bool before_) internal {
        (bytes[6] memory p, bytes4[6] memory errs) = _payloads();
        bytes32 planKey = _trialPlan(1 days);
        _subscribe(planKey);
        vm.prank(customer);
        mgr.createMandate(subKey, PRICE, 5 * PRICE, uint40(T0 + 100 days));
        vm.warp(T0 + 1 days);
        for (uint256 i; i < p.length; ++i) {
            uint256 snap = vm.snapshotState();
            tok.arm(ReentrantToken.Hook.TransferFrom, address(mgr), p[i], before_);
            if (viaCharge) {
                vm.prank(stranger);
                mgr.charge(subKey);
            } else {
                vm.prank(customer);
                mgr.renew(subKey);
            }
            _assertBlocked();
            assertEq(bytes4(tok.attackReturn()), errs[i], "revert selector");
            assertEq(_sub(subKey).chargeCount, 1);
            assertEq(_sub(subKey).nextChargeAt, T0 + 1 days + INTERVAL);
            assertEq(_man(subKey).spent, viaCharge ? PRICE : 0);
            assertEq(tok.balanceOf(payout), PRICE);
            assertEq(tok.balanceOf(customer), CUSTOMER_FUNDS - PRICE);
            vm.revertToState(snap);
        }
    }

    function test_Reentrancy_Charge_HookBefore() public {
        _paymentUnderAttack(true, true);
    }

    function test_Reentrancy_Charge_HookAfter() public {
        _paymentUnderAttack(true, false);
    }

    function test_Reentrancy_Renew_HookBefore() public {
        _paymentUnderAttack(false, true);
    }

    function test_Reentrancy_Renew_HookAfter() public {
        _paymentUnderAttack(false, false);
    }
}

/// @dev Fee-on-transfer settlement token: escrow plans must fail closed and leave no trace.
contract RetempoSubscriptionManagerFeeTokenTest is RetempoSystemBase {
    FeeOnTransferToken internal fee;
    bytes32 internal subKey;

    function setUp() public override {
        vm.warp(T0);
        fee = new FeeOnTransferToken();
        _wire(address(fee));
        fee.mint(customer, CUSTOMER_FUNDS);
        vm.prank(customer);
        fee.approve(address(mgr), type(uint256).max);
        subKey = mgr.subscriptionKey(customer, SREF);
    }

    function test_FeeToken_EscrowSubscribeRevertsWithDepositMismatch() public {
        bytes32 planKey = _escrowPlan();
        uint256 got = fee.received(PRICE);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(DepositMismatch.selector, uint256(PRICE), uint256(0), got));
        mgr.subscribe(SREF, planKey, arb);
        assertEq(uint8(_sub(subKey).status), 0, "no subscription recorded");
        assertEq(fee.balanceOf(customer), CUSTOMER_FUNDS);
        assertEq(fee.balanceOf(address(mgr)), 0);
        assertEq(fee.balanceOf(address(escrow)), 0);
    }

    function _trialEscrowSubWithMandate() internal {
        bytes32 planKey = _plan(PREF, PRICE, INTERVAL, 1 days, GRACE, VEST);
        _subscribe(planKey);
        vm.prank(customer);
        mgr.createMandate(subKey, PRICE, 5 * PRICE, uint40(T0 + 100 days));
        vm.warp(T0 + 1 days);
    }

    function test_FeeToken_ChargeRevertsAndLeavesNoStateChange() public {
        _trialEscrowSubWithMandate();
        uint40 due = _sub(subKey).nextChargeAt;
        uint256 got = fee.received(PRICE);
        vm.expectRevert(abi.encodeWithSelector(DepositMismatch.selector, uint256(PRICE), uint256(0), got));
        _charge(subKey);
        assertEq(_sub(subKey).nextChargeAt, due);
        assertEq(_sub(subKey).chargeCount, 0);
        assertEq(_man(subKey).spent, 0);
        assertEq(fee.balanceOf(customer), CUSTOMER_FUNDS);
        assertEq(fee.balanceOf(address(mgr)), 0);
        assertEq(fee.balanceOf(address(escrow)), 0);
        assertEq(fee.allowance(address(mgr), address(escrow)), 0);
    }

    function test_FeeToken_RenewRevertsAndLeavesNoStateChange() public {
        _trialEscrowSubWithMandate();
        uint40 due = _sub(subKey).nextChargeAt;
        uint256 got = fee.received(PRICE);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(DepositMismatch.selector, uint256(PRICE), uint256(0), got));
        mgr.renew(subKey);
        assertEq(_sub(subKey).nextChargeAt, due);
        assertEq(_sub(subKey).chargeCount, 0);
        assertEq(_man(subKey).spent, 0);
        assertEq(fee.balanceOf(customer), CUSTOMER_FUNDS);
    }

    /// @dev Direct plans do no balance check: the payee simply receives the net amount (documented behavior).
    function test_FeeToken_DirectPlanPaysNetOfFee() public {
        bytes32 planKey = _directPlan();
        _subscribe(planKey);
        assertEq(fee.balanceOf(payout), fee.received(PRICE));
        assertEq(fee.balanceOf(address(mgr)), 0);
    }
}

/// @dev Blocklisted counterparties (Arc USDC semantics) and native-value rejection.
contract RetempoSubscriptionManagerBlocklistTest is RetempoSystemBase {
    bytes32 internal planKey;
    bytes32 internal subKey;

    function _live() internal {
        (planKey, subKey) = _directSub();
        _mandate(subKey, PRICE, 10 * PRICE, T0 + 300 days);
        vm.warp(T0 + INTERVAL);
    }

    function test_Blocklist_BlockedPayoutMakesDirectChargeRevertWithoutStateChange() public {
        _live();
        usdc.setBlocked(payout, true);
        uint256 custBal = usdc.balanceOf(customer);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocked.selector, payout));
        _charge(subKey);
        assertEq(_sub(subKey).chargeCount, 1);
        assertEq(_sub(subKey).nextChargeAt, T0 + INTERVAL);
        assertEq(_man(subKey).spent, 0);
        assertEq(usdc.balanceOf(customer), custBal);
        assertEq(usdc.balanceOf(address(mgr)), 0);
        // manual renew fails the same way
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocked.selector, payout));
        mgr.renew(subKey);
    }

    function test_Blocklist_BlockedPayoutBlocksNewSubscribeButNotOtherPlans() public {
        planKey = _directPlan();
        usdc.setBlocked(payout, true);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocked.selector, payout));
        mgr.subscribe(SREF, planKey, address(0));
        // a plan paying a different address is unaffected
        vm.prank(merchant2);
        bytes32 p2 = mgr.createPlan(keccak256("p2"), payout2, PRICE, INTERVAL, 0, GRACE, 0, address(0), false);
        bytes32 s2 = _subscribeAs(customer, keccak256("s2"), p2);
        assertEq(usdc.balanceOf(payout2), PRICE);
        assertEq(_sub(s2).chargeCount, 1);
    }

    function test_Blocklist_OtherCustomersAndPlansUnaffected() public {
        _live();
        // second customer on a different merchant/payout
        vm.prank(merchant2);
        bytes32 p2 = mgr.createPlan(PREF, payout2, PRICE, INTERVAL, 0, GRACE, 0, address(0), false);
        vm.warp(T0);
        bytes32 s2 = _subscribeAs(customer2, SREF, p2);
        vm.prank(customer2);
        mgr.createMandate(s2, PRICE, 5 * PRICE, uint40(T0 + 100 days));
        vm.warp(T0 + INTERVAL);
        usdc.setBlocked(payout, true);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocked.selector, payout));
        _charge(subKey);
        _charge(s2); // unaffected
        assertEq(usdc.balanceOf(payout2), 2 * PRICE);
        assertEq(_sub(s2).chargeCount, 2);
    }

    function test_Blocklist_MerchantCanRecoverByChangingPayout() public {
        _live();
        usdc.setBlocked(payout, true);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocked.selector, payout));
        _charge(subKey);
        vm.prank(merchant);
        mgr.setPlanPayout(planKey, payout2);
        _charge(subKey);
        assertEq(usdc.balanceOf(payout2), PRICE);
        assertEq(_sub(subKey).chargeCount, 2);
    }

    function test_Blocklist_BlockedCustomerRevertsOnlyThatSubscription() public {
        _live();
        bytes32 s2 = _subscribeAs(customer2, SREF, planKey); // paid at T0+INTERVAL timestamp; due after another interval
        vm.prank(customer2);
        mgr.createMandate(s2, PRICE, 5 * PRICE, uint40(block.timestamp + 100 days));
        usdc.setBlocked(customer, true);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocked.selector, customer));
        _charge(subKey);
        assertEq(_sub(subKey).chargeCount, 1);
        assertEq(_man(subKey).spent, 0);
        // blocked customer can still exit
        vm.prank(customer);
        mgr.revokeMandate(subKey);
        vm.prank(customer);
        mgr.cancelSubscription(subKey);
        vm.warp(block.timestamp + INTERVAL);
        _charge(s2);
        assertEq(_sub(s2).chargeCount, 2);
    }

    // ------------------------------------------------------------ native value

    function test_NativeValue_Rejected() public {
        _live();
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(mgr).call{value: 1 ether}("");
        assertFalse(ok, "no receive");
        (ok,) = address(mgr).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok, "no fallback");
        bytes[8] memory calls = [
            abi.encodeCall(mgr.charge, (subKey)),
            abi.encodeCall(mgr.renew, (subKey)),
            abi.encodeCall(mgr.subscribe, (keccak256("x"), planKey, address(0))),
            abi.encodeCall(mgr.createMandate, (subKey, PRICE, PRICE, uint40(T0 + INTERVAL + 5))),
            abi.encodeCall(mgr.revokeMandate, (subKey)),
            abi.encodeCall(mgr.cancelSubscription, (subKey)),
            abi.encodeCall(mgr.setPlanPayout, (planKey, payout2)),
            abi.encodeCall(mgr.createPlan, (keccak256("y"), payout, PRICE, INTERVAL, 0, GRACE, 0, address(0), false))
        ];
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(i == 0 ? stranger : (i < 6 ? customer : merchant));
            vm.deal(i == 0 ? stranger : (i < 6 ? customer : merchant), 1 ether);
            (ok,) = address(mgr).call{value: 1}(calls[i]);
            assertFalse(ok, "non-payable");
        }
        assertEq(address(mgr).balance, 0);
        assertEq(address(escrow).balance, 0);
    }
}
