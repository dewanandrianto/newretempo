// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IAccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {RetempoEscrow} from "../RetempoEscrow.sol";
import {RetempoSubscriptionManager} from "../RetempoSubscriptionManager.sol";
import {ZeroAddress, InvalidParameter, AdminRenounceDisabled} from "../interfaces/RetempoErrors.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {RetempoSystemBase} from "./helpers/RetempoSystemBase.sol";

/// @dev Core units: constructor, linkage, roles, pause and the CONFIG-controlled payment limit.
contract RetempoSubscriptionManagerCoreTest is RetempoSystemBase {
    bytes32 internal constant DEFAULT_ADMIN = 0x00;

    // ------------------------------------------------------------ constructor

    function test_Constructor_ZeroUsdcReverts() public {
        vm.expectRevert(ZeroAddress.selector);
        new RetempoSubscriptionManager(address(0), address(escrow), admin, ADMIN_DELAY, pauser, configMgr);
    }

    function test_Constructor_ZeroEscrowReverts() public {
        vm.expectRevert(ZeroAddress.selector);
        new RetempoSubscriptionManager(address(usdc), address(0), admin, ADMIN_DELAY, pauser, configMgr);
    }

    /// @dev The OZ base constructor rejects a zero admin before the contract's own ZeroAddress check.
    function test_Constructor_ZeroAdminReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, address(0)));
        new RetempoSubscriptionManager(address(usdc), address(escrow), address(0), ADMIN_DELAY, pauser, configMgr);
    }

    function test_Constructor_ZeroPauserReverts() public {
        vm.expectRevert(ZeroAddress.selector);
        new RetempoSubscriptionManager(address(usdc), address(escrow), admin, ADMIN_DELAY, address(0), configMgr);
    }

    function test_Constructor_ZeroConfigReverts() public {
        vm.expectRevert(ZeroAddress.selector);
        new RetempoSubscriptionManager(address(usdc), address(escrow), admin, ADMIN_DELAY, pauser, address(0));
    }

    function test_Constructor_PauserEqualsAdminReverts() public {
        vm.expectRevert(InvalidParameter.selector);
        new RetempoSubscriptionManager(address(usdc), address(escrow), admin, ADMIN_DELAY, admin, configMgr);
    }

    /// @dev `escrow` (from setUp) designates the real `mgr`, so a second manager cannot link to it.
    function test_Constructor_EscrowManagerMismatchReverts() public {
        vm.expectRevert(RetempoSubscriptionManager.ManagerLinkMismatch.selector);
        new RetempoSubscriptionManager(address(usdc), address(escrow), admin, ADMIN_DELAY, pauser, configMgr);
    }

    function test_Constructor_EscrowDesignatingArbitraryManagerReverts() public {
        RetempoEscrow other = new RetempoEscrow(address(usdc), makeAddr("notManager"), admin, ADMIN_DELAY, pauser, configMgr, arbMgr, MAX_EXPOSURE);
        vm.expectRevert(RetempoSubscriptionManager.ManagerLinkMismatch.selector);
        new RetempoSubscriptionManager(address(usdc), address(other), admin, ADMIN_DELAY, pauser, configMgr);
    }

    function test_Constructor_EscrowUsdcMismatchReverts() public {
        MockUSDC otherToken = new MockUSDC();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        RetempoEscrow e = new RetempoEscrow(address(otherToken), predicted, admin, ADMIN_DELAY, pauser, configMgr, arbMgr, MAX_EXPOSURE);
        vm.expectRevert(RetempoSubscriptionManager.TokenLinkMismatch.selector);
        new RetempoSubscriptionManager(address(usdc), address(e), admin, ADMIN_DELAY, pauser, configMgr);
    }

    function test_Constructor_StartsPausedWithRolesAndDefaults() public {
        (RetempoEscrow e, RetempoSubscriptionManager m) = _deploySystem(address(usdc)); // asserts linkage + paused
        assertTrue(m.paused());
        assertTrue(m.hasRole(m.CONFIG_ROLE(), configMgr));
        assertTrue(m.hasRole(m.PAUSER_ROLE(), pauser));
        assertTrue(m.hasRole(DEFAULT_ADMIN, admin));
        assertFalse(m.hasRole(m.PAUSER_ROLE(), admin));
        assertFalse(m.hasRole(m.CONFIG_ROLE(), admin));
        assertEq(m.defaultAdmin(), admin);
        assertEq(m.defaultAdminDelay(), ADMIN_DELAY);
        assertEq(m.maxPaymentAmount(), 10_000e6);
        assertEq(address(m.escrow()), address(e));
        // paused manager rejects new plans until unpaused
        vm.prank(merchant);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        m.createPlan(PREF, payout, PRICE, INTERVAL, 0, GRACE, 0, address(0), false);
    }

    // ------------------------------------------------------------ roles

    function test_Admin_DelayedTransfer() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        mgr.beginDefaultAdminTransfer(newAdmin);
        (address pending, uint48 schedule) = mgr.pendingDefaultAdmin();
        assertEq(pending, newAdmin);
        assertEq(schedule, uint48(block.timestamp) + ADMIN_DELAY);

        vm.prank(newAdmin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, schedule));
        mgr.acceptDefaultAdminTransfer();
        assertEq(mgr.defaultAdmin(), admin);

        vm.warp(schedule + 1);
        vm.prank(newAdmin);
        mgr.acceptDefaultAdminTransfer();
        assertEq(mgr.defaultAdmin(), newAdmin);
        assertTrue(mgr.hasRole(DEFAULT_ADMIN, newAdmin));
        assertFalse(mgr.hasRole(DEFAULT_ADMIN, admin));
    }

    function test_Admin_TransferOnlyByAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, DEFAULT_ADMIN));
        mgr.beginDefaultAdminTransfer(stranger);
    }

    function test_RenounceDefaultAdminReverts() public {
        vm.prank(admin);
        vm.expectRevert(AdminRenounceDisabled.selector);
        mgr.renounceRole(DEFAULT_ADMIN, admin);
        assertTrue(mgr.hasRole(DEFAULT_ADMIN, admin));
    }

    function test_RenounceDefaultAdminRevertsForNonHolderToo() public {
        vm.prank(stranger);
        vm.expectRevert(AdminRenounceDisabled.selector);
        mgr.renounceRole(DEFAULT_ADMIN, stranger);
    }

    function test_PauserMayRenounceOwnRole() public {
        bytes32 role = mgr.PAUSER_ROLE();
        vm.prank(pauser);
        mgr.renounceRole(role, pauser);
        assertFalse(mgr.hasRole(role, pauser));
    }

    function test_RenounceWithBadConfirmationReverts() public {
        bytes32 role = mgr.PAUSER_ROLE();
        vm.prank(pauser);
        vm.expectRevert(IAccessControl.AccessControlBadConfirmation.selector);
        mgr.renounceRole(role, stranger);
    }

    // ------------------------------------------------------------ pause / unpause

    function test_PauserCanPauseAndEmits() public {
        vm.expectEmit(true, true, true, true, address(mgr));
        emit Pausable.Paused(pauser);
        _pauseMgr();
        assertTrue(mgr.paused());
    }

    function test_PauseRevertsForNonPauser() public {
        bytes32 role = mgr.PAUSER_ROLE();
        address[4] memory callers = [stranger, admin, configMgr, merchant];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, callers[i], role));
            mgr.pause();
        }
        assertFalse(mgr.paused());
    }

    function test_PauseWhenAlreadyPausedReverts() public {
        _pauseMgr();
        vm.prank(pauser);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        mgr.pause();
    }

    function test_AdminCanUnpauseAndEmits() public {
        _pauseMgr();
        vm.expectEmit(true, true, true, true, address(mgr));
        emit Pausable.Unpaused(admin);
        vm.prank(admin);
        mgr.unpause();
        assertFalse(mgr.paused());
    }

    function test_UnpauseRevertsForNonAdmin() public {
        _pauseMgr();
        address[4] memory callers = [stranger, pauser, configMgr, merchant];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, callers[i], DEFAULT_ADMIN));
            mgr.unpause();
        }
        assertTrue(mgr.paused());
    }

    function test_UnpauseWhenNotPausedReverts() public {
        vm.prank(admin);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        mgr.unpause();
    }

    // ------------------------------------------------------------ setMaxPaymentAmount

    function test_SetMaxPaymentAmount_UpdatesAndEmits() public {
        vm.expectEmit(true, false, false, true, address(mgr));
        emit RetempoSubscriptionManager.ParameterUpdated(mgr.MAX_PAYMENT_AMOUNT_KEY(), 10_000e6, 25_000e6);
        _setLimit(25_000e6);
        assertEq(mgr.maxPaymentAmount(), 25_000e6);
    }

    function test_SetMaxPaymentAmount_BoundsInclusive() public {
        _setLimit(mgr.MIN_PAYMENT());
        assertEq(mgr.maxPaymentAmount(), mgr.MIN_PAYMENT());
        _setLimit(mgr.HARD_MAX_AMOUNT());
        assertEq(mgr.maxPaymentAmount(), mgr.HARD_MAX_AMOUNT());
    }

    function test_SetMaxPaymentAmount_OutOfBoundsReverts() public {
        uint256 lo = mgr.MIN_PAYMENT() - 1;
        uint256 hi = mgr.HARD_MAX_AMOUNT() + 1;
        vm.startPrank(configMgr);
        vm.expectRevert(InvalidParameter.selector);
        mgr.setMaxPaymentAmount(lo);
        vm.expectRevert(InvalidParameter.selector);
        mgr.setMaxPaymentAmount(0);
        vm.expectRevert(InvalidParameter.selector);
        mgr.setMaxPaymentAmount(hi);
        vm.expectRevert(InvalidParameter.selector);
        mgr.setMaxPaymentAmount(type(uint256).max);
        vm.stopPrank();
        assertEq(mgr.maxPaymentAmount(), 10_000e6);
    }

    function test_SetMaxPaymentAmount_OnlyConfigRole() public {
        bytes32 role = mgr.CONFIG_ROLE();
        address[4] memory callers = [stranger, admin, pauser, merchant];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, callers[i], role));
            mgr.setMaxPaymentAmount(1e9);
        }
        assertEq(mgr.maxPaymentAmount(), 10_000e6);
    }

    function test_SetMaxPaymentAmount_WorksWhilePaused() public {
        _pauseMgr();
        _setLimit(5_000e6);
        assertEq(mgr.maxPaymentAmount(), 5_000e6);
    }

    function test_Constants() public view {
        assertEq(mgr.HARD_MAX_AMOUNT(), 1e15);
        assertEq(mgr.MIN_PAYMENT(), 10_000);
        assertEq(mgr.MAX_MANDATE_DURATION(), 366 days);
        assertEq(mgr.MIN_INTERVAL(), 1 days);
        assertEq(mgr.MAX_INTERVAL(), 366 days);
    }
}
