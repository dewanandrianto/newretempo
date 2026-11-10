// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RetempoSystemBase} from "./helpers/RetempoSystemBase.sol";
import {RetempoEscrow} from "../RetempoEscrow.sol";
import {RetempoSubscriptionManager} from "../RetempoSubscriptionManager.sol";

/// @notice Reproduces existing financial-policy gaps; passing is not owner acceptance.
contract RetempoPolicyEvidenceTest is RetempoSystemBase {
    function test_ChangedDisputeWindowsCannotDebitAnExistingMandate() public {
        (, bytes32 subKey) = _escrowSub();
        _stdMandate(subKey);
        RetempoEscrow.Escrow memory first = escrow.getEscrow(_routedKey(merchant, subKey, 1));
        RetempoSubscriptionManager.Mandate memory beforeMandate = mgr.getMandate(subKey);
        uint256 beforeCustomer = usdc.balanceOf(customer);
        uint256 beforeEscrow = usdc.balanceOf(address(escrow));
        uint32 chargeCount = mgr.getSubscription(subKey).chargeCount;
        vm.startPrank(configMgr);
        escrow.setResponseWindow(2 days);
        escrow.setResolutionTimeout(8 days);
        vm.stopPrank();
        vm.warp(mgr.getSubscription(subKey).nextChargeAt);
        (bool canCharge,) = mgr.canCharge(subKey);
        assertFalse(canCharge, "changed terms require explicit renewed consent");
        vm.expectRevert();
        _charge(subKey);
        assertEq(usdc.balanceOf(customer), beforeCustomer);
        assertEq(usdc.balanceOf(address(escrow)), beforeEscrow);
        assertEq(mgr.getSubscription(subKey).chargeCount, chargeCount);
        assertEq(mgr.getMandate(subKey).spent, beforeMandate.spent);
        assertEq(mgr.getMandate(subKey).nonce, beforeMandate.nonce);
        assertEq(escrow.getEscrow(_routedKey(merchant, subKey, 2)).amount, 0);
        assertEq(escrow.getEscrow(_routedKey(merchant, subKey, 1)).responseWindow, first.responseWindow);
    }

    function test_BeforeTimeoutArbitratorMayResolve() public {
        (, bytes32 subKey) = _escrowSub();
        bytes32 key = _routedKey(merchant, subKey, 1);
        vm.prank(customer);
        escrow.openDispute(key, PRICE, keccak256("policy-evidence"));
        RetempoEscrow.Escrow memory opened = escrow.getEscrow(key);
        vm.warp(uint256(opened.disputedAt) + opened.resolutionTimeout - 1);
        vm.prank(arb);
        escrow.resolveDispute(key, PRICE, bytes32(0));
        assertEq(escrow.withdrawableOf(merchant), PRICE);
        assertEq(escrow.totalLocked(), 0);
    }

    function test_AtTimeoutOnlyExpirationMayAllocate() public { _timeoutOrdering(0); }
    function test_AfterTimeoutOnlyExpirationMayAllocate() public { _timeoutOrdering(1); }

    function _timeoutOrdering(uint256 afterDeadline) private {
        (, bytes32 subKey) = _escrowSub();
        bytes32 key = _routedKey(merchant, subKey, 1);
        vm.prank(customer);
        escrow.openDispute(key, PRICE, keccak256("policy-evidence"));
        RetempoEscrow.Escrow memory opened = escrow.getEscrow(key);
        assertEq(opened.carvedVested, 0);
        vm.warp(uint256(opened.disputedAt) + opened.resolutionTimeout + afterDeadline);
        vm.prank(arb);
        vm.expectRevert(bytes4(keccak256("ResolutionWindowEnded()")));
        escrow.resolveDispute(key, PRICE, bytes32(0));
        assertEq(escrow.withdrawableOf(merchant), 0);
        assertEq(escrow.withdrawableOf(customer), 0);
        assertEq(escrow.getEscrow(key).frozen, PRICE);
        escrow.expireDispute(key);
        assertEq(escrow.withdrawableOf(merchant), 0);
        assertEq(escrow.withdrawableOf(customer), PRICE);
        assertEq(escrow.totalLocked(), 0);
        assertEq(escrow.totalWithdrawable(), PRICE);
    }
}
