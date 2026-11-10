// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {RetempoEscrow} from "../../RetempoEscrow.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Shared fixture. Contains NO test functions (every category inherits it).
abstract contract RetempoBase is Test {
    uint256 internal constant MERCHANT_PK = 0xA11CE;
    uint256 internal constant CUSTOMER_PK = 0xB0B;
    uint256 internal constant T0 = 1_700_000_000;
    uint48 internal constant ADMIN_DELAY = 1 days;
    uint256 internal constant MAX_EXPOSURE = 1e18;

    uint128 internal constant AMOUNT = 90e6;
    uint32 internal constant DURATION = 30 days;
    bytes32 internal constant REF = keccak256("invoice-1");
    bytes32 internal constant HASH = keccak256("evidence");

    address internal admin = makeAddr("admin"); // multisig stand-in
    address internal pauser = makeAddr("pauser");
    address internal configMgr = makeAddr("configMgr");
    address internal arbMgr = makeAddr("arbMgr");
    address internal manager = makeAddr("manager"); // predicted subscription-manager stand-in
    address internal arb = makeAddr("arb");
    address internal arb2 = makeAddr("arb2");
    address internal stranger = makeAddr("stranger");
    address internal payout = makeAddr("payout");
    address internal merchant = vm.addr(MERCHANT_PK);
    address internal customer = vm.addr(CUSTOMER_PK);

    RetempoEscrow internal escrow;
    MockUSDC internal usdc;

    function setUp() public virtual {
        vm.warp(T0);
        usdc = new MockUSDC();
        escrow = _deploy(address(usdc));
        _bootstrap(escrow);
        usdc.mint(customer, 1e15);
        usdc.mint(manager, 1e15);
        vm.prank(customer);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(manager);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _deploy(address token) internal returns (RetempoEscrow e) {
        e = new RetempoEscrow(token, manager, admin, ADMIN_DELAY, pauser, configMgr, arbMgr, MAX_EXPOSURE);
    }

    /// @dev Escrows are deployed paused: admin unpauses, arbitrator manager allowlists arb and arb2.
    function _bootstrap(RetempoEscrow e) internal {
        vm.prank(admin);
        e.unpause();
        vm.startPrank(arbMgr);
        e.addArbitrator(arb);
        e.addArbitrator(arb2);
        vm.stopPrank();
    }

    function _key(bytes32 ref) internal view returns (bytes32) {
        return escrow.escrowKey(merchant, ref);
    }

    function _create(bytes32 ref, uint128 amount, uint32 dur, bool refundable) internal returns (bytes32 key) {
        vm.prank(merchant);
        key = escrow.createEscrow(ref, customer, amount, dur, arb, refundable);
    }

    function _fund(bytes32 key) internal {
        bytes32 h = escrow.termsHash(key); // evaluate before prank (external call would consume it)
        vm.prank(customer);
        escrow.fund(key, arb, h);
    }

    function _createAndFund(bytes32 ref, uint128 amount, uint32 dur, bool refundable) internal returns (bytes32 key) {
        key = _create(ref, amount, dur, refundable);
        _fund(key);
    }

    function _std() internal returns (bytes32) {
        return _createAndFund(REF, AMOUNT, DURATION, false);
    }

    function _stdRefundable() internal returns (bytes32) {
        return _createAndFund(REF, AMOUNT, DURATION, true);
    }

    function _e(bytes32 key) internal view returns (RetempoEscrow.Escrow memory) {
        return escrow.getEscrow(key);
    }

    function _claim(bytes32 key) internal {
        vm.prank(merchant);
        escrow.claim(key);
    }

    function _dispute(bytes32 key, uint128 x) internal {
        vm.prank(customer);
        escrow.openDispute(key, x, HASH);
    }

    function _resolve(bytes32 key, uint128 m) internal {
        vm.prank(arb);
        escrow.resolveDispute(key, m, HASH);
    }

    function _vestedAt(uint256 amount, uint256 dur, uint256 elapsed) internal pure returns (uint256) {
        if (elapsed >= dur) return amount;
        return (amount * elapsed) / dur;
    }
}
