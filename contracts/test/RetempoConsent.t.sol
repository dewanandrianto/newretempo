// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RetempoSystemBase} from "./helpers/RetempoSystemBase.sol";
import {RetempoSubscriptionManager} from "../RetempoSubscriptionManager.sol";

contract RetempoConsentTest is RetempoSystemBase {
    event EscrowTermsAccepted(bytes32 indexed subKey, address indexed customer, uint32 responseWindow, uint32 resolutionTimeout);

    function test_SubscribeEmitsInitialAcceptedWindows() public {
        bytes32 plan = _escrowPlan();
        bytes32 key = mgr.subscriptionKey(customer, SREF);
        vm.expectEmit(true, true, false, true, address(mgr));
        emit EscrowTermsAccepted(key, customer, 7 days, 30 days);
        _subscribe(plan);
        (uint32 response, uint32 resolution) = mgr.acceptedEscrowTerms(key);
        assertEq(response, 7 days);
        assertEq(resolution, 30 days);
    }
    function _accept(bytes32 key, uint32 response, uint32 resolution) internal {
        vm.prank(customer);
        (bool ok, bytes memory result) = address(mgr).call(
            abi.encodeWithSignature("acceptEscrowTerms(bytes32,uint32,uint32)", key, response, resolution)
        );
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
    }

    function test_RenewedConsentRevokesMandateAndRequiresNewGeneration() public {
        (, bytes32 key) = _escrowSub();
        _stdMandate(key);
        vm.warp(_sub(key).nextChargeAt);
        _charge(key);
        vm.warp(_sub(key).nextChargeAt);
        vm.prank(configMgr);
        escrow.setResponseWindow(2 days);
        _accept(key, 2 days, 30 days);
        assertFalse(_man(key).active);
        assertEq(_man(key).spent, PRICE);
        assertEq(_man(key).nonce, 1);
        vm.expectRevert(RetempoSubscriptionManager.MandateInactive.selector);
        _charge(key);
        _stdMandate(key);
        _charge(key);
        assertEq(_sub(key).chargeCount, 3);
        assertEq(_man(key).nonce, 2);
        assertEq(_man(key).spent, PRICE);
    }

    function test_StaleResponseCannotBeAccepted() public {
        (, bytes32 key) = _escrowSub();
        vm.prank(configMgr);
        escrow.setResponseWindow(2 days);
        vm.expectRevert(RetempoSubscriptionManager.EscrowTermsNotAccepted.selector);
        _accept(key, 7 days, 30 days);
        (uint32 response, uint32 resolution) = mgr.acceptedEscrowTerms(key);
        assertEq(response, 7 days);
        assertEq(resolution, 30 days);
    }

    function test_CanceledSubscriptionCannotAccept() public {
        (, bytes32 key) = _escrowSub();
        vm.prank(customer);
        mgr.cancelSubscription(key);
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionInactive.selector);
        _accept(key, 7 days, 30 days);
    }

    function test_DirectSubscriptionCannotAccept() public {
        (, bytes32 key) = _directSub();
        vm.expectRevert(bytes4(keccak256("InvalidParameter()")));
        _accept(key, 7 days, 30 days);
    }

    function test_PausedManagerCannotAccept() public {
        (, bytes32 key) = _escrowSub();
        _pauseMgr();
        vm.expectRevert(bytes4(keccak256("EnforcedPause()")));
        _accept(key, 7 days, 30 days);
    }

    function test_UnchangedConsentPreservesSpentNonceAndActiveMandate() public {
        (, bytes32 key) = _escrowSub();
        _stdMandate(key);
        vm.warp(_sub(key).nextChargeAt);
        _charge(key);
        bytes32 beforeMandate = keccak256(abi.encode(_man(key)));
        _accept(key, 7 days, 30 days);
        assertEq(keccak256(abi.encode(_man(key))), beforeMandate);
    }

    function test_ChangedResolutionRejectsManualWithoutMutation() public {
        (, bytes32 key) = _escrowSub();
        _stdMandate(key);
        vm.warp(_sub(key).nextChargeAt);
        vm.prank(configMgr);
        escrow.setResolutionTimeout(8 days);
        _assertRejectedWithoutMutation(key, false);
    }

    function test_ChangedResolutionRejectsRecurringWithoutMutation() public {
        (, bytes32 key) = _escrowSub();
        _stdMandate(key);
        vm.warp(_sub(key).nextChargeAt);
        vm.prank(configMgr);
        escrow.setResolutionTimeout(8 days);
        _assertRejectedWithoutMutation(key, true);
    }

    function test_ChangedResponseRejectsManualWithoutMutation() public {
        (, bytes32 key) = _escrowSub();
        _stdMandate(key);
        vm.warp(_sub(key).nextChargeAt);
        vm.prank(configMgr);
        escrow.setResponseWindow(2 days);
        _assertRejectedWithoutMutation(key, false);
    }

    function _assertRejectedWithoutMutation(bytes32 key, bool recurring) internal {
        uint256 customerBalance = usdc.balanceOf(customer);
        uint256 escrowBalance = usdc.balanceOf(address(escrow));
        uint256 managerBalance = usdc.balanceOf(address(mgr));
        uint256 allowance = usdc.allowance(customer, address(mgr));
        bytes32 beforeSub = keccak256(abi.encode(_sub(key)));
        bytes32 beforeMandate = keccak256(abi.encode(_man(key)));
        assertEq(_reason(key), 13);
        vm.expectRevert(RetempoSubscriptionManager.EscrowTermsNotAccepted.selector);
        if (recurring) _charge(key); else _renew(key);
        assertEq(usdc.balanceOf(customer), customerBalance);
        assertEq(usdc.balanceOf(address(escrow)), escrowBalance);
        assertEq(usdc.balanceOf(address(mgr)), managerBalance);
        assertEq(usdc.allowance(customer, address(mgr)), allowance);
        assertEq(keccak256(abi.encode(_sub(key))), beforeSub);
        assertEq(keccak256(abi.encode(_man(key))), beforeMandate);
    }

    function test_StaleResolutionCannotBeAccepted() public {
        (, bytes32 key) = _escrowSub();
        _stdMandate(key);
        vm.prank(configMgr);
        escrow.setResolutionTimeout(8 days);
        bytes32 beforeMandate = keccak256(abi.encode(_man(key)));
        vm.expectRevert(RetempoSubscriptionManager.EscrowTermsNotAccepted.selector);
        _accept(key, 7 days, 30 days);
        (uint32 response, uint32 resolution) = mgr.acceptedEscrowTerms(key);
        assertEq(response, 7 days);
        assertEq(resolution, 30 days);
        assertEq(keccak256(abi.encode(_man(key))), beforeMandate);
    }

    function test_RenewedConsentEmitsEventAndManualRenewFundsAcceptedWindows() public {
        (, bytes32 key) = _escrowSub();
        vm.warp(_sub(key).nextChargeAt);
        vm.startPrank(configMgr);
        escrow.setResponseWindow(2 days);
        escrow.setResolutionTimeout(8 days);
        vm.stopPrank();
        vm.expectEmit(true, true, false, true, address(mgr));
        emit EscrowTermsAccepted(key, customer, 2 days, 8 days);
        _accept(key, 2 days, 8 days);
        _renew(key);
        assertEq(_sub(key).chargeCount, 2);
        assertEq(escrow.getEscrow(_routedKey(merchant, key, 2)).responseWindow, 2 days);
        assertEq(escrow.getEscrow(_routedKey(merchant, key, 2)).resolutionTimeout, 8 days);
        assertEq(escrow.getEscrow(_routedKey(merchant, key, 1)).responseWindow, 7 days);
        assertEq(escrow.getEscrow(_routedKey(merchant, key, 1)).resolutionTimeout, 30 days);
    }

    function test_TrialSubscriptionCapturesWindowsBeforeFirstPayment() public {
        bytes32 plan = _plan(PREF, PRICE, INTERVAL, 1 days, GRACE, VEST);
        bytes32 key = _subscribe(plan);
        (uint32 response, uint32 resolution) = mgr.acceptedEscrowTerms(key);
        assertEq(response, 7 days);
        assertEq(resolution, 30 days);
        assertEq(_sub(key).chargeCount, 0);
        vm.prank(configMgr);
        escrow.setResponseWindow(2 days);
        vm.warp(_sub(key).nextChargeAt);
        _assertRejectedWithoutMutation(key, false);
    }

    function test_DirectSubscriptionIsUnaffectedByWindowChanges() public {
        (, bytes32 key) = _directSub();
        _stdMandate(key);
        vm.prank(configMgr);
        escrow.setResponseWindow(2 days);
        vm.warp(_sub(key).nextChargeAt);
        _charge(key);
        assertEq(_sub(key).chargeCount, 2);
        (uint32 response, uint32 resolution) = mgr.acceptedEscrowTerms(key);
        assertEq(response, 0);
        assertEq(resolution, 0);
    }

    function test_MissingSubscriptionCannotAccept() public {
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        _accept(keccak256("missing"), 7 days, 30 days);
    }

    function testFuzz_ChangedWindowsRejectBothPaymentPaths(uint32 rawResponse, uint32 rawResolution) public {
        (, bytes32 key) = _escrowSub();
        _stdMandate(key);
        uint32 response = uint32(bound(rawResponse, 1 days, 29 days));
        uint32 resolution = uint32(bound(rawResolution, 31 days, 90 days));
        vm.startPrank(configMgr);
        escrow.setResolutionTimeout(resolution);
        escrow.setResponseWindow(response);
        vm.stopPrank();
        vm.warp(_sub(key).nextChargeAt);
        _assertRejectedWithoutMutation(key, true);
        _assertRejectedWithoutMutation(key, false);
    }

    function test_OnlyCustomerCanAccept() public {
        (, bytes32 key) = _escrowSub();
        vm.prank(stranger);
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        mgr.acceptEscrowTerms(key, 7 days, 30 days);
    }

    function test_ChangedResponseRejectsRecurringWithoutMutation() public {
        (, bytes32 key) = _escrowSub();
        _stdMandate(key);
        vm.warp(_sub(key).nextChargeAt);
        vm.prank(configMgr);
        escrow.setResponseWindow(2 days);
        uint256 balance = usdc.balanceOf(customer);
        bytes32 beforeSub = keccak256(abi.encode(_sub(key)));
        bytes32 beforeMandate = keccak256(abi.encode(_man(key)));
        vm.expectRevert(bytes4(keccak256("EscrowTermsNotAccepted()")));
        _charge(key);
        assertEq(_reason(key), 13);
        assertEq(usdc.balanceOf(customer), balance);
        assertEq(keccak256(abi.encode(_sub(key))), beforeSub);
        assertEq(keccak256(abi.encode(_man(key))), beforeMandate);
    }
}
