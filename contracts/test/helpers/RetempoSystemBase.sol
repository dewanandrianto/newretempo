// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {RetempoEscrow} from "../../RetempoEscrow.sol";
import {RetempoSubscriptionManager} from "../../RetempoSubscriptionManager.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Shared two-contract fixture (escrow + subscription manager). Contains NO test functions.
abstract contract RetempoSystemBase is Test {
    uint256 internal constant T0 = 1_700_000_000;
    uint48 internal constant ADMIN_DELAY = 1 days;
    uint256 internal constant MAX_EXPOSURE = 1e18;

    uint128 internal constant PRICE = 100e6;
    uint32 internal constant INTERVAL = 30 days;
    uint32 internal constant GRACE = 3 days;
    uint32 internal constant VEST = 14 days;
    bytes32 internal constant PREF = keccak256("plan-1");
    bytes32 internal constant SREF = keccak256("sub-1");
    uint256 internal constant CUSTOMER_FUNDS = 1e12; // 1,000,000 USDC

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal configMgr = makeAddr("configMgr");
    address internal arbMgr = makeAddr("arbMgr");
    address internal arb = makeAddr("arb");
    address internal arb2 = makeAddr("arb2");
    address internal stranger = makeAddr("stranger");
    address internal payout = makeAddr("payout");
    address internal payout2 = makeAddr("payout2");
    address internal merchant = makeAddr("merchant");
    address internal merchant2 = makeAddr("merchant2");
    address internal customer = makeAddr("customer");
    address internal customer2 = makeAddr("customer2");

    MockUSDC internal usdc;
    RetempoEscrow internal escrow;
    RetempoSubscriptionManager internal mgr;

    function setUp() public virtual {
        vm.warp(T0);
        usdc = new MockUSDC();
        _wire(address(usdc));
        usdc.mint(customer, CUSTOMER_FUNDS);
        usdc.mint(customer2, CUSTOMER_FUNDS);
        _approveMgr(customer);
        _approveMgr(customer2);
    }

    function _approveMgr(address who) internal {
        vm.prank(who);
        usdc.approve(address(mgr), type(uint256).max);
    }

    /// @dev Deploys the escrow with the PREDICTED manager address, then the manager; asserts linkage.
    function _deploySystem(address token) internal returns (RetempoEscrow e, RetempoSubscriptionManager m) {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        e = new RetempoEscrow(token, predicted, admin, ADMIN_DELAY, pauser, configMgr, arbMgr, MAX_EXPOSURE);
        m = new RetempoSubscriptionManager(token, address(e), admin, ADMIN_DELAY, pauser, configMgr);
        assertEq(address(m), predicted, "predicted manager address");
        assertEq(e.manager(), address(m), "escrow.manager linkage");
        assertEq(address(m.escrow()), address(e), "manager.escrow linkage");
        assertEq(address(m.usdc()), token, "manager usdc");
        assertEq(address(e.usdc()), token, "escrow usdc");
        assertTrue(m.paused(), "manager starts paused");
        assertTrue(e.paused(), "escrow starts paused");
    }

    /// @dev Admin unpauses both contracts, arbitrator manager allowlists `arb` and `arb2`.
    function _bootstrap(RetempoEscrow e, RetempoSubscriptionManager m) internal {
        vm.startPrank(admin);
        e.unpause();
        m.unpause();
        vm.stopPrank();
        vm.startPrank(arbMgr);
        e.addArbitrator(arb);
        e.addArbitrator(arb2);
        vm.stopPrank();
    }

    function _wire(address token) internal {
        (escrow, mgr) = _deploySystem(token);
        _bootstrap(escrow, mgr);
    }

    // ---------------------------------------------------------------- builders

    function _plan(bytes32 ref, uint128 amount, uint32 interval, uint32 trial, uint32 grace, uint32 vest)
        internal
        returns (bytes32 key)
    {
        vm.prank(merchant);
        key = mgr.createPlan(ref, payout, amount, interval, trial, grace, vest, vest == 0 ? address(0) : arb, false);
    }

    function _directPlan() internal returns (bytes32) {
        return _plan(PREF, PRICE, INTERVAL, 0, GRACE, 0);
    }

    function _trialPlan(uint32 trial) internal returns (bytes32) {
        return _plan(PREF, PRICE, INTERVAL, trial, GRACE, 0);
    }

    function _escrowPlan() internal returns (bytes32) {
        return _plan(PREF, PRICE, INTERVAL, 0, GRACE, VEST);
    }

    function _accepted(bytes32 planKey) internal view returns (address) {
        RetempoSubscriptionManager.Plan memory p = mgr.getPlan(planKey);
        return p.vestDuration == 0 ? address(0) : p.arbitrator;
    }

    function _subscribeAs(address who, bytes32 sref, bytes32 planKey) internal returns (bytes32 subKey) {
        address acc = _accepted(planKey);
        vm.prank(who);
        subKey = mgr.subscribe(sref, planKey, acc);
    }

    function _subscribe(bytes32 planKey) internal returns (bytes32) {
        return _subscribeAs(customer, SREF, planKey);
    }

    /// @dev Direct plan (no trial) + subscription; first period already paid at T0.
    function _directSub() internal returns (bytes32 planKey, bytes32 subKey) {
        planKey = _directPlan();
        subKey = _subscribe(planKey);
    }

    function _escrowSub() internal returns (bytes32 planKey, bytes32 subKey) {
        planKey = _escrowPlan();
        subKey = _subscribe(planKey);
    }

    function _mandate(bytes32 subKey, uint128 per, uint128 total, uint256 expiry) internal {
        vm.prank(customer);
        mgr.createMandate(subKey, per, total, uint40(expiry));
    }

    /// @dev Standard mandate: per-charge PRICE, total 3*PRICE, valid for 90 days.
    function _stdMandate(bytes32 subKey) internal {
        _mandate(subKey, PRICE, 3 * PRICE, block.timestamp + 90 days);
    }

    function _charge(bytes32 subKey) internal {
        vm.prank(stranger);
        mgr.charge(subKey);
    }

    function _renew(bytes32 subKey) internal {
        vm.prank(customer);
        mgr.renew(subKey);
    }

    function _sub(bytes32 subKey) internal view returns (RetempoSubscriptionManager.Subscription memory) {
        return mgr.getSubscription(subKey);
    }

    function _man(bytes32 subKey) internal view returns (RetempoSubscriptionManager.Mandate memory) {
        return mgr.getMandate(subKey);
    }

    function _reason(bytes32 subKey) internal view returns (uint8 r) {
        (, r) = mgr.canCharge(subKey);
    }

    function _setLimit(uint256 v) internal {
        vm.prank(configMgr);
        mgr.setMaxPaymentAmount(v);
    }

    function _pauseMgr() internal {
        vm.prank(pauser);
        mgr.pause();
    }

    /// @dev invoice reference the manager derives for payment number `n`.
    function _invoiceRef(bytes32 subKey, uint32 n) internal pure returns (bytes32) {
        return keccak256(abi.encode(subKey, n));
    }

    function _routedKey(address merchant_, bytes32 subKey, uint32 n) internal pure returns (bytes32) {
        return keccak256(abi.encode(merchant_, _invoiceRef(subKey, n)));
    }
}
