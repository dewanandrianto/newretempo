// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {RetempoSubscriptionManager} from "../RetempoSubscriptionManager.sol";
import {Unauthorized} from "../interfaces/RetempoErrors.sol";
import {RetempoSystemBase} from "./helpers/RetempoSystemBase.sol";

/// @dev Unauthorized-caller matrix for every restricted function.
contract RetempoSubscriptionManagerAuthTest is RetempoSystemBase {
    bytes32 internal constant DEFAULT_ADMIN = 0x00;
    bytes32 internal planKey;
    bytes32 internal subKey;

    function setUp() public override {
        super.setUp();
        (planKey, subKey) = _directSub();
        _mandate(subKey, PRICE, 3 * PRICE, T0 + 90 days);
        vm.warp(T0 + INTERVAL);
    }

    /// @dev Callers that hold no role and are no party to the subscription/plan.
    function _outsiders() internal view returns (address[8] memory c) {
        c = [stranger, admin, pauser, configMgr, arbMgr, merchant2, customer2, address(escrow)];
    }

    function _denyAll(address[] memory callers, bytes memory data, bytes memory err) internal {
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(err);
            (bool ok,) = address(mgr).call(data);
            ok; // swallowed by expectRevert
        }
    }

    function _toDyn(address[8] memory a) internal pure returns (address[] memory d) {
        d = new address[](a.length);
        for (uint256 i; i < a.length; ++i) d[i] = a[i];
    }

    function _role(address who, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, role);
    }

    function test_Matrix_PartyGatedFunctionsRejectOutsiders() public {
        address[] memory o = _toDyn(_outsiders());
        bytes memory unauth = abi.encodeWithSelector(Unauthorized.selector);
        _denyAll(o, abi.encodeCall(mgr.renew, (subKey)), unauth);
        _denyAll(o, abi.encodeCall(mgr.createMandate, (subKey, PRICE, PRICE, uint40(T0 + 90 days))), unauth);
        _denyAll(o, abi.encodeCall(mgr.revokeMandate, (subKey)), unauth);
        _denyAll(o, abi.encodeCall(mgr.cancelSubscription, (subKey)), unauth);
        _denyAll(o, abi.encodeCall(mgr.setPlanActive, (planKey, false)), unauth);
        _denyAll(o, abi.encodeCall(mgr.setPlanPayout, (planKey, payout2)), unauth);
        // nothing changed
        assertEq(_sub(subKey).chargeCount, 1);
        assertEq(uint8(_sub(subKey).status), 1);
        assertEq(_man(subKey).nonce, 1);
        assertTrue(_man(subKey).active);
        assertTrue(mgr.getPlan(planKey).active);
        assertEq(mgr.getPlan(planKey).payout, payout);
    }

    function test_Matrix_RoleGatedFunctions() public {
        bytes32 pr = mgr.PAUSER_ROLE();
        bytes32 cr = mgr.CONFIG_ROLE();
        // pause: not admin, config, strangers, parties
        address[5] memory np = [stranger, admin, configMgr, merchant, customer];
        for (uint256 i; i < np.length; ++i) {
            vm.prank(np[i]);
            vm.expectRevert(_role(np[i], pr));
            mgr.pause();
        }
        _pauseMgr();
        // unpause: only admin
        address[5] memory nu = [stranger, pauser, configMgr, merchant, customer];
        for (uint256 i; i < nu.length; ++i) {
            vm.prank(nu[i]);
            vm.expectRevert(_role(nu[i], DEFAULT_ADMIN));
            mgr.unpause();
        }
        assertTrue(mgr.paused());
        // setMaxPaymentAmount: only CONFIG
        address[5] memory nc = [stranger, admin, pauser, merchant, customer];
        for (uint256 i; i < nc.length; ++i) {
            vm.prank(nc[i]);
            vm.expectRevert(_role(nc[i], cr));
            mgr.setMaxPaymentAmount(1e9);
        }
        assertEq(mgr.maxPaymentAmount(), 10_000e6);
    }

    function test_Matrix_AdminManagementFunctionsRejectNonAdmin() public {
        address[4] memory c = [stranger, pauser, configMgr, merchant];
        bytes32 pr = mgr.PAUSER_ROLE();
        for (uint256 i; i < c.length; ++i) {
            bytes memory err = _role(c[i], DEFAULT_ADMIN);
            _denyOne(c[i], abi.encodeCall(mgr.beginDefaultAdminTransfer, (c[i])), err);
            _denyOne(c[i], abi.encodeCall(mgr.cancelDefaultAdminTransfer, ()), err);
            _denyOne(c[i], abi.encodeCall(mgr.changeDefaultAdminDelay, (uint48(1))), err);
            _denyOne(c[i], abi.encodeCall(mgr.rollbackDefaultAdminDelay, ()), err);
            _denyOne(c[i], abi.encodeCall(mgr.grantRole, (pr, c[i])), err);
            _denyOne(c[i], abi.encodeCall(mgr.revokeRole, (pr, pauser)), err);
        }
        assertTrue(mgr.hasRole(pr, pauser));
        assertFalse(mgr.hasRole(pr, stranger));
    }

    function _denyOne(address who, bytes memory data, bytes memory err) internal {
        vm.prank(who);
        vm.expectRevert(err);
        (bool ok,) = address(mgr).call(data);
        ok;
    }

    /// @dev Even the admin has no power over customer subscriptions, mandates, prices or funds.
    function test_Matrix_AdminCannotTouchCustomerState() public {
        bytes memory unauth = abi.encodeWithSelector(Unauthorized.selector);
        _denyOne(admin, abi.encodeCall(mgr.cancelSubscription, (subKey)), unauth);
        _denyOne(admin, abi.encodeCall(mgr.revokeMandate, (subKey)), unauth);
        _denyOne(admin, abi.encodeCall(mgr.renew, (subKey)), unauth);
        _denyOne(admin, abi.encodeCall(mgr.setPlanPayout, (planKey, admin)), unauth);
        assertEq(usdc.balanceOf(address(mgr)), 0);
        assertEq(usdc.allowance(customer, admin), 0);
    }

    function test_Matrix_EscrowCannotCallBackIntoManager() public {
        bytes memory unauth = abi.encodeWithSelector(Unauthorized.selector);
        _denyOne(address(escrow), abi.encodeCall(mgr.cancelSubscription, (subKey)), unauth);
        _denyOne(address(escrow), abi.encodeCall(mgr.renew, (subKey)), unauth);
    }

    /// @dev Only the manager may fund routed escrows; anyone else (incl. admin and the merchant) is rejected by escrow.
    function test_Matrix_EscrowFundFromManagerOnlyManager() public {
        address[4] memory c = [stranger, admin, merchant, customer];
        for (uint256 i; i < c.length; ++i) {
            vm.prank(c[i]);
            vm.expectRevert(Unauthorized.selector);
            escrow.fundFromManager(keccak256("x"), merchant, customer, PRICE, VEST, arb, false);
        }
    }

    function test_Matrix_ChargeIsPermissionless_ButCannotRedirectFunds() public {
        // every outsider may trigger charge; funds always flow customer -> plan payout only
        address[8] memory o = _outsiders();
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < o.length; ++i) {
            uint256 oBefore = usdc.balanceOf(o[i]);
            vm.prank(o[i]);
            mgr.charge(subKey);
            assertEq(usdc.balanceOf(o[i]), oBefore, "caller gains nothing");
            assertEq(usdc.balanceOf(payout), 2 * PRICE);
            vm.revertToState(snap);
        }
    }
}
