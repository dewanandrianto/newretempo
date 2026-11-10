// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RetempoBase} from "./helpers/RetempoBase.sol";
import {RetempoEscrow} from "../RetempoEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";
import {
    ZeroAddress,
    Unauthorized,
    InvalidReference,
    InvalidAmount,
    InvalidParameter,
    DepositMismatch,
    AdminRenounceDisabled,
    AmountOutOfBounds
} from "../interfaces/RetempoErrors.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IAccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @notice Unit tests: constructor, roles/admin, config, allowlist, creation, funding, vesting, claim, refunds.
contract RetempoEscrowTest is RetempoBase {
    bytes32 internal constant REF2 = keccak256("invoice-2");

    function _unauth(address who, bytes32 role) internal {
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, role));
    }

    // ───────────────────────── constructor ─────────────────────────

    function test_Constructor_StartsPausedAndStoresConfig() public {
        RetempoEscrow e = _deploy(address(usdc));
        assertTrue(e.paused());
        assertEq(address(e.usdc()), address(usdc));
        assertEq(e.manager(), manager);
        assertEq(e.maxAggregateExposure(), MAX_EXPOSURE);
        assertEq(e.minAmount(), 10_000);
        assertEq(e.maxEscrowAmount(), 10_000e6);
        assertEq(e.responseWindow(), 7 days);
        assertEq(e.resolutionTimeout(), 30 days);
        assertEq(e.defaultAdmin(), admin);
        assertEq(e.defaultAdminDelay(), ADMIN_DELAY);
        assertTrue(e.hasRole(e.PAUSER_ROLE(), pauser));
        assertTrue(e.hasRole(e.CONFIG_ROLE(), configMgr));
        assertTrue(e.hasRole(e.ARBITRATOR_MANAGER_ROLE(), arbMgr));
        assertFalse(e.hasRole(e.PAUSER_ROLE(), admin));
        vm.prank(merchant);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        e.createEscrow(REF, customer, AMOUNT, DURATION, arb, false);
    }

    function test_Constructor_RevertsOnZeroAddresses() public {
        address t = address(usdc);
        vm.expectRevert(ZeroAddress.selector);
        new RetempoEscrow(address(0), manager, admin, ADMIN_DELAY, pauser, configMgr, arbMgr, MAX_EXPOSURE);
        vm.expectRevert(ZeroAddress.selector);
        new RetempoEscrow(t, address(0), admin, ADMIN_DELAY, pauser, configMgr, arbMgr, MAX_EXPOSURE);
        vm.expectRevert(ZeroAddress.selector);
        new RetempoEscrow(t, manager, admin, ADMIN_DELAY, address(0), configMgr, arbMgr, MAX_EXPOSURE);
        vm.expectRevert(ZeroAddress.selector);
        new RetempoEscrow(t, manager, admin, ADMIN_DELAY, pauser, address(0), arbMgr, MAX_EXPOSURE);
        vm.expectRevert(ZeroAddress.selector);
        new RetempoEscrow(t, manager, admin, ADMIN_DELAY, pauser, configMgr, address(0), MAX_EXPOSURE);
    }

    function test_Constructor_RevertsOnZeroAdmin() public {
        vm.expectRevert(abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, address(0)));
        new RetempoEscrow(address(usdc), manager, address(0), ADMIN_DELAY, pauser, configMgr, arbMgr, MAX_EXPOSURE);
    }

    function test_Constructor_RevertsWhenPauserIsAdmin() public {
        vm.expectRevert(InvalidParameter.selector);
        new RetempoEscrow(address(usdc), manager, admin, ADMIN_DELAY, admin, configMgr, arbMgr, MAX_EXPOSURE);
    }

    function test_Constructor_RevertsOnZeroExposure() public {
        vm.expectRevert(InvalidParameter.selector);
        new RetempoEscrow(address(usdc), manager, admin, ADMIN_DELAY, pauser, configMgr, arbMgr, 0);
    }

    /// The constructor window-ordering check is unreachable with the hard-coded defaults (7d < 30d);
    /// the same ordering rule is enforced (and tested) through the setters.
    function test_WindowOrdering_EnforcedBySetters() public {
        vm.startPrank(configMgr);
        vm.expectRevert(RetempoEscrow.InvalidWindowOrder.selector);
        escrow.setResponseWindow(30 days); // == resolutionTimeout
        vm.expectRevert(RetempoEscrow.InvalidWindowOrder.selector);
        escrow.setResolutionTimeout(7 days); // == responseWindow
        escrow.setResolutionTimeout(8 days);
        vm.expectRevert(RetempoEscrow.InvalidWindowOrder.selector);
        escrow.setResponseWindow(8 days);
        escrow.setResponseWindow(7 days + 1);
        vm.stopPrank();
    }

    // ───────────────────────── roles & admin ─────────────────────────

    function test_DefaultAdminTransfer_DelayedAndWorks() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        escrow.beginDefaultAdminTransfer(newAdmin);
        vm.prank(newAdmin);
        vm.expectRevert(); // delay not elapsed
        escrow.acceptDefaultAdminTransfer();
        skip(ADMIN_DELAY + 1);
        vm.prank(newAdmin);
        escrow.acceptDefaultAdminTransfer();
        assertEq(escrow.defaultAdmin(), newAdmin);
        assertFalse(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), admin));
        // new admin can pause-cycle; old cannot unpause
        vm.prank(pauser);
        escrow.pause();
        bytes32 adminRole = escrow.DEFAULT_ADMIN_ROLE();
        vm.prank(admin);
        _unauth(admin, adminRole);
        escrow.unpause();
        vm.prank(newAdmin);
        escrow.unpause();
        assertFalse(escrow.paused());
    }

    function test_RenounceDefaultAdmin_Reverts() public {
        bytes32 role = escrow.DEFAULT_ADMIN_ROLE();
        vm.prank(admin);
        vm.expectRevert(AdminRenounceDisabled.selector);
        escrow.renounceRole(role, admin);
        assertEq(escrow.defaultAdmin(), admin);
    }

    function test_RenounceNonAdminRole_Works() public {
        bytes32 role = escrow.PAUSER_ROLE();
        vm.prank(pauser);
        escrow.renounceRole(role, pauser);
        assertFalse(escrow.hasRole(role, pauser));
    }

    function test_Pause_OnlyPauser() public {
        bytes32 role = escrow.PAUSER_ROLE();
        vm.prank(stranger);
        _unauth(stranger, role);
        escrow.pause();
        vm.prank(admin);
        _unauth(admin, role);
        escrow.pause();
        vm.prank(pauser);
        vm.expectEmit(false, false, false, true, address(escrow));
        emit Pausable.Paused(pauser);
        escrow.pause();
        assertTrue(escrow.paused());
        // pausing twice reverts
        vm.prank(pauser);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.pause();
    }

    function test_Unpause_OnlyAdmin() public {
        vm.prank(pauser);
        escrow.pause();
        bytes32 role = escrow.DEFAULT_ADMIN_ROLE();
        vm.prank(pauser);
        _unauth(pauser, role);
        escrow.unpause();
        vm.prank(stranger);
        _unauth(stranger, role);
        escrow.unpause();
        vm.prank(admin);
        vm.expectEmit(false, false, false, true, address(escrow));
        emit Pausable.Unpaused(admin);
        escrow.unpause();
        assertFalse(escrow.paused());
        vm.prank(admin);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        escrow.unpause();
    }

    // ───────────────────────── config ─────────────────────────

    function test_Config_OnlyConfigRole() public {
        bytes32 role = escrow.CONFIG_ROLE();
        address[2] memory callers = [stranger, admin];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(callers[i]);
            _unauth(callers[i], role);
            escrow.setMinAmount(1);
            _unauth(callers[i], role);
            escrow.setMaxEscrowAmount(1e9);
            _unauth(callers[i], role);
            escrow.setMaxAggregateExposure(1);
            _unauth(callers[i], role);
            escrow.setResponseWindow(2 days);
            _unauth(callers[i], role);
            escrow.setResolutionTimeout(40 days);
            vm.stopPrank();
        }
    }

    function test_Config_HappyPathEmitsParameterUpdated() public {
        vm.startPrank(configMgr);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit RetempoEscrow.ParameterUpdated(escrow.MIN_AMOUNT_KEY(), 10_000, 5);
        escrow.setMinAmount(5);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit RetempoEscrow.ParameterUpdated(escrow.MAX_ESCROW_AMOUNT_KEY(), 10_000e6, 1e12);
        escrow.setMaxEscrowAmount(1e12);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit RetempoEscrow.ParameterUpdated(escrow.MAX_AGGREGATE_EXPOSURE_KEY(), MAX_EXPOSURE, 77);
        escrow.setMaxAggregateExposure(77);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit RetempoEscrow.ParameterUpdated(escrow.RESPONSE_WINDOW_KEY(), 7 days, 2 days);
        escrow.setResponseWindow(2 days);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit RetempoEscrow.ParameterUpdated(escrow.RESOLUTION_TIMEOUT_KEY(), 30 days, 40 days);
        escrow.setResolutionTimeout(40 days);
        vm.stopPrank();
        assertEq(escrow.minAmount(), 5);
        assertEq(escrow.maxEscrowAmount(), 1e12);
        assertEq(escrow.maxAggregateExposure(), 77);
        assertEq(escrow.responseWindow(), 2 days);
        assertEq(escrow.resolutionTimeout(), 40 days);
    }

    function test_Config_Bounds() public {
        uint256 hardMax = escrow.HARD_MAX_AMOUNT();
        vm.startPrank(configMgr);
        vm.expectRevert(InvalidParameter.selector);
        escrow.setMinAmount(0);
        vm.expectRevert(InvalidParameter.selector);
        escrow.setMinAmount(10_000e6 + 1); // > maxEscrowAmount
        escrow.setMinAmount(10_000e6); // == max ok
        vm.expectRevert(InvalidParameter.selector);
        escrow.setMaxEscrowAmount(10_000e6 - 1); // < min
        vm.expectRevert(InvalidParameter.selector);
        escrow.setMaxEscrowAmount(hardMax + 1);
        escrow.setMaxEscrowAmount(hardMax);
        vm.expectRevert(InvalidParameter.selector);
        escrow.setMaxAggregateExposure(0);
        vm.expectRevert(InvalidParameter.selector);
        escrow.setResponseWindow(1 days - 1);
        vm.expectRevert(InvalidParameter.selector);
        escrow.setResponseWindow(30 days + 1);
        escrow.setResponseWindow(1 days);
        vm.expectRevert(InvalidParameter.selector);
        escrow.setResolutionTimeout(7 days - 1);
        vm.expectRevert(InvalidParameter.selector);
        escrow.setResolutionTimeout(90 days + 1);
        escrow.setResolutionTimeout(90 days);
        escrow.setResponseWindow(30 days); // now allowed since timeout is 90d
        vm.stopPrank();
    }

    function test_Config_WorksWhilePausedAndAppliesToNewEscrowsOnly() public {
        bytes32 key = _std();
        vm.prank(pauser);
        escrow.pause();
        vm.startPrank(configMgr);
        escrow.setResponseWindow(2 days);
        escrow.setResolutionTimeout(10 days);
        vm.stopPrank();
        vm.prank(admin);
        escrow.unpause();
        RetempoEscrow.Escrow memory old = _e(key);
        assertEq(old.responseWindow, 7 days);
        assertEq(old.resolutionTimeout, 30 days);
        bytes32 key2 = _create(REF2, AMOUNT, DURATION, false);
        RetempoEscrow.Escrow memory fresh = _e(key2);
        assertEq(fresh.responseWindow, 2 days);
        assertEq(fresh.resolutionTimeout, 10 days);
    }

    // ───────────────────────── arbitrator allowlist ─────────────────────────

    function test_Allowlist_OnlyManagerAddsAndRemoves() public {
        bytes32 role = escrow.ARBITRATOR_MANAGER_ROLE();
        address newArb = makeAddr("newArb");
        vm.prank(stranger);
        _unauth(stranger, role);
        escrow.addArbitrator(newArb);
        vm.prank(admin);
        _unauth(admin, role);
        escrow.addArbitrator(newArb);
        vm.prank(configMgr);
        _unauth(configMgr, role);
        escrow.removeArbitrator(arb);
        vm.startPrank(arbMgr);
        vm.expectEmit(true, false, false, false, address(escrow));
        emit RetempoEscrow.ArbitratorAdded(newArb);
        escrow.addArbitrator(newArb);
        assertTrue(escrow.isArbitrator(newArb));
        vm.expectEmit(true, false, false, false, address(escrow));
        emit RetempoEscrow.ArbitratorRemoved(newArb);
        escrow.removeArbitrator(newArb);
        vm.stopPrank();
        assertFalse(escrow.isArbitrator(newArb));
    }

    function test_Allowlist_AddingRoleHolderOrZeroReverts() public {
        vm.startPrank(arbMgr);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.addArbitrator(admin);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.addArbitrator(pauser);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.addArbitrator(configMgr);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.addArbitrator(arbMgr);
        vm.expectRevert(ZeroAddress.selector);
        escrow.addArbitrator(address(0));
        vm.expectRevert(ZeroAddress.selector);
        escrow.removeArbitrator(address(0));
        vm.stopPrank();
    }

    function test_Allowlist_WorksWhilePaused() public {
        vm.prank(pauser);
        escrow.pause();
        address a = makeAddr("a");
        vm.prank(arbMgr);
        escrow.addArbitrator(a);
        assertTrue(escrow.isArbitrator(a));
    }

    // ───────────────────────── creation ─────────────────────────

    function test_Create_StoresTermsAndEmits() public {
        bytes32 key = _key(REF);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit RetempoEscrow.EscrowCreated(key, merchant, customer, REF, AMOUNT, DURATION, arb, true, 7 days, 30 days);
        assertEq(_create(REF, AMOUNT, DURATION, true), key);
        RetempoEscrow.Escrow memory e = _e(key);
        assertEq(e.merchant, merchant);
        assertEq(e.customer, customer);
        assertEq(e.arbitrator, arb);
        assertEq(e.amount, AMOUNT);
        assertEq(e.vestDuration, DURATION);
        assertTrue(e.customerMayRefundUnvested);
        assertEq(uint8(e.status), uint8(RetempoEscrow.Status.Pending));
        assertEq(escrow.balanceOf(key), 0);
        assertEq(escrow.vestedAmount(key), 0);
        assertEq(escrow.claimableAmount(key), 0);
    }

    function test_Create_ValidationReverts() public {
        vm.startPrank(merchant);
        vm.expectRevert(InvalidReference.selector);
        escrow.createEscrow(bytes32(0), customer, AMOUNT, DURATION, arb, false);
        vm.expectRevert(ZeroAddress.selector);
        escrow.createEscrow(REF, address(0), AMOUNT, DURATION, arb, false);
        vm.expectRevert(Unauthorized.selector); // same party
        escrow.createEscrow(REF, merchant, AMOUNT, DURATION, arb, false);
        vm.expectRevert(InvalidAmount.selector);
        escrow.createEscrow(REF, customer, 9_999, DURATION, arb, false);
        vm.expectRevert(abi.encodeWithSelector(AmountOutOfBounds.selector, uint256(10_000e6 + 1), uint256(10_000), uint256(10_000e6)));
        escrow.createEscrow(REF, customer, 10_000e6 + 1, DURATION, arb, false);
        vm.expectRevert(RetempoEscrow.InvalidDuration.selector);
        escrow.createEscrow(REF, customer, AMOUNT, 1 hours - 1, arb, false);
        vm.expectRevert(RetempoEscrow.InvalidDuration.selector);
        escrow.createEscrow(REF, customer, AMOUNT, 90 days + 1, arb, false);
        vm.stopPrank();
    }

    function test_Create_BoundaryValuesAccepted() public {
        vm.startPrank(merchant);
        escrow.createEscrow(keccak256("a"), customer, 10_000, 1 hours, arb, false);
        escrow.createEscrow(keccak256("b"), customer, 10_000e6, 90 days, arb, false);
        vm.stopPrank();
    }

    function test_Create_ArbitratorChecks() public {
        vm.startPrank(merchant);
        vm.expectRevert(ZeroAddress.selector);
        escrow.createEscrow(REF, customer, AMOUNT, DURATION, address(0), false);
        vm.expectRevert(RetempoEscrow.ArbitratorNotAllowed.selector);
        escrow.createEscrow(REF, customer, AMOUNT, DURATION, stranger, false);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.createEscrow(REF, customer, AMOUNT, DURATION, merchant, false);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.createEscrow(REF, customer, AMOUNT, DURATION, customer, false);
        vm.stopPrank();
        // allowlisted arbitrator that later acquires a role becomes conflicted
        bytes32 role = escrow.PAUSER_ROLE();
        vm.prank(admin);
        escrow.grantRole(role, arb);
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.createEscrow(REF, customer, AMOUNT, DURATION, arb, false);
    }

    function test_Create_DuplicateKeyReverts() public {
        _create(REF, AMOUNT, DURATION, false);
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.EscrowExists.selector);
        escrow.createEscrow(REF, customer, AMOUNT, DURATION, arb, false);
        // same ref from another merchant is a different key
        vm.prank(stranger);
        escrow.createEscrow(REF, customer, AMOUNT, DURATION, arb, false);
    }

    // ───────────────────────── cancelUnfunded ─────────────────────────

    function test_Cancel_MerchantOnlyPendingOnlyWorksWhilePaused() public {
        bytes32 key = _create(REF, AMOUNT, DURATION, false);
        vm.prank(customer);
        vm.expectRevert(Unauthorized.selector);
        escrow.cancelUnfunded(key);
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        escrow.cancelUnfunded(key);
        vm.prank(pauser);
        escrow.pause();
        vm.expectEmit(true, false, false, false, address(escrow));
        emit RetempoEscrow.EscrowCancelled(key);
        vm.prank(merchant);
        escrow.cancelUnfunded(key);
        assertEq(uint8(_e(key).status), uint8(RetempoEscrow.Status.Cancelled));
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.InvalidStatus.selector);
        escrow.cancelUnfunded(key);
        // cancelled key cannot be reused or funded
        vm.prank(admin);
        escrow.unpause();
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.EscrowExists.selector);
        escrow.createEscrow(REF, customer, AMOUNT, DURATION, arb, false);
        bytes32 h = escrow.termsHash(key);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.InvalidStatus.selector);
        escrow.fund(key, arb, h);
    }

    function test_Cancel_FundedEscrowReverts() public {
        bytes32 key = _std();
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.InvalidStatus.selector);
        escrow.cancelUnfunded(key);
    }

    // CONTINUED in RetempoEscrow.Funding.t.sol (fund, vesting, claim, refunds)
}
