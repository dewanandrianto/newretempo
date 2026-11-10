// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RetempoBase} from "./helpers/RetempoBase.sol";
import {RetempoEscrow} from "../RetempoEscrow.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";
import {Unauthorized, InvalidAmount, DepositMismatch, AmountOutOfBounds} from "../interfaces/RetempoErrors.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @notice Unit tests: fund, fundFromManager, vesting math, claim, merchant/customer refunds.
contract RetempoEscrowFundingTest is RetempoBase {
    bytes32 internal constant REF2 = keccak256("invoice-2");

    // ───────────────────────── fund ─────────────────────────

    function test_Fund_HappyPathMovesTokensAndEmits() public {
        bytes32 key = _create(REF, AMOUNT, DURATION, false);
        bytes32 h = escrow.termsHash(key);
        uint256 custBefore = usdc.balanceOf(customer);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit RetempoEscrow.ArbitratorAccepted(key, customer, arb, false);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.EscrowFunded(key, customer, AMOUNT, uint40(T0), uint40(T0 + DURATION), false);
        vm.prank(customer);
        escrow.fund(key, arb, h);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(usdc.balanceOf(customer), custBefore - AMOUNT);
        assertEq(escrow.totalLocked(), AMOUNT);
        assertEq(escrow.balanceOf(key), AMOUNT);
        assertEq(escrow.freeBalanceOf(key), AMOUNT);
        RetempoEscrow.Escrow memory e = _e(key);
        assertEq(uint8(e.status), uint8(RetempoEscrow.Status.Active));
        assertEq(e.vestStart, T0);
    }

    function test_Fund_OnlyCustomer() public {
        bytes32 key = _create(REF, AMOUNT, DURATION, false);
        bytes32 h = escrow.termsHash(key);
        vm.prank(merchant);
        vm.expectRevert(Unauthorized.selector);
        escrow.fund(key, arb, h);
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        escrow.fund(key, arb, h);
        vm.prank(customer);
        vm.expectRevert(Unauthorized.selector); // unknown key
        escrow.fund(keccak256("nope"), arb, h);
    }

    function test_Fund_WrongArbitratorAndTermsHash() public {
        bytes32 key = _create(REF, AMOUNT, DURATION, false);
        bytes32 h = escrow.termsHash(key);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.ArbitratorMismatch.selector);
        escrow.fund(key, arb2, h);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.TermsMismatch.selector);
        escrow.fund(key, arb, bytes32(uint256(h) ^ 1));
    }

    function test_Fund_TermsHashBindsRefundFlagAndAmount() public {
        bytes32 k1 = _create(REF, AMOUNT, DURATION, false);
        bytes32 k2 = _create(REF2, AMOUNT, DURATION, true);
        assertTrue(escrow.termsHash(k1) != escrow.termsHash(k2));
        // a hash computed for one escrow cannot fund another
        bytes32 h1 = escrow.termsHash(k1);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.TermsMismatch.selector);
        escrow.fund(k2, arb, h1);
    }

    function test_Fund_ArbitratorRemovedOrConflictedAfterCreationReverts() public {
        bytes32 key = _create(REF, AMOUNT, DURATION, false);
        bytes32 h = escrow.termsHash(key);
        vm.prank(arbMgr);
        escrow.removeArbitrator(arb);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.ArbitratorNotAllowed.selector);
        escrow.fund(key, arb, h);
        vm.prank(arbMgr);
        escrow.addArbitrator(arb);
        bytes32 role = escrow.CONFIG_ROLE();
        vm.prank(admin);
        escrow.grantRole(role, arb);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.fund(key, arb, h);
    }

    function test_Fund_InsufficientAllowanceReverts() public {
        bytes32 key = _create(REF, AMOUNT, DURATION, false);
        bytes32 h = escrow.termsHash(key);
        vm.prank(customer);
        usdc.approve(address(escrow), 10);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(escrow), 10, uint256(AMOUNT)));
        escrow.fund(key, arb, h);
    }

    function test_Fund_ExposureLimit() public {
        vm.prank(configMgr);
        escrow.setMaxAggregateExposure(100e6);
        _createAndFund(REF, AMOUNT, DURATION, false);
        bytes32 k2 = _create(REF2, 20e6, DURATION, false);
        bytes32 h = escrow.termsHash(k2);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(RetempoEscrow.ExposureExceeded.selector, uint256(90e6), uint256(20e6), uint256(100e6)));
        escrow.fund(k2, arb, h);
        // credited-but-unwithdrawn funds still count toward exposure
        skip(DURATION);
        _claim(_key(REF));
        assertEq(escrow.totalLocked() + escrow.totalWithdrawable(), 90e6);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(RetempoEscrow.ExposureExceeded.selector, uint256(90e6), uint256(20e6), uint256(100e6)));
        escrow.fund(k2, arb, h);
        // exactly at the limit is allowed
        vm.prank(merchant);
        escrow.withdraw(merchant);
        vm.prank(configMgr);
        escrow.setMaxAggregateExposure(20e6);
        vm.prank(customer);
        escrow.fund(k2, arb, h);
    }

    function test_Fund_PerEscrowCapAndMinimumRecheckedAtFunding() public {
        bytes32 key = _create(REF, 5_000e6, DURATION, false);
        bytes32 h = escrow.termsHash(key);
        vm.prank(configMgr);
        escrow.setMaxEscrowAmount(1_000e6);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(AmountOutOfBounds.selector, uint256(5_000e6), uint256(10_000), uint256(1_000e6)));
        escrow.fund(key, arb, h);
        vm.prank(configMgr);
        escrow.setMaxEscrowAmount(6_000e6);
        vm.prank(configMgr);
        escrow.setMinAmount(5_000e6 + 1);
        vm.prank(customer);
        vm.expectRevert(InvalidAmount.selector);
        escrow.fund(key, arb, h);
    }

    function test_Fund_FeeOnTransferTokenReverts() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        RetempoEscrow e2 = _deploy(address(fot));
        _bootstrap(e2);
        fot.mint(customer, 1_000e6);
        vm.prank(customer);
        fot.approve(address(e2), type(uint256).max);
        vm.prank(merchant);
        bytes32 key = e2.createEscrow(REF, customer, AMOUNT, DURATION, arb, false);
        bytes32 h = e2.termsHash(key);
        uint256 got = fot.received(AMOUNT);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(DepositMismatch.selector, uint256(AMOUNT), uint256(0), got));
        e2.fund(key, arb, h);
        assertEq(uint8(e2.getEscrow(key).status), uint8(RetempoEscrow.Status.Pending));
        assertEq(e2.totalLocked(), 0);
        assertEq(fot.balanceOf(customer), 1_000e6);
    }

    function test_Fund_DuplicateFundingReverts() public {
        bytes32 key = _std();
        bytes32 h = escrow.termsHash(key);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.InvalidStatus.selector);
        escrow.fund(key, arb, h);
    }

    function test_Fund_RevertsWhilePaused() public {
        bytes32 key = _create(REF, AMOUNT, DURATION, false);
        bytes32 h = escrow.termsHash(key);
        vm.prank(pauser);
        escrow.pause();
        vm.prank(customer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.fund(key, arb, h);
    }

    // ───────────────────────── fundFromManager ─────────────────────────

    function test_FundFromManager_HappyPath() public {
        bytes32 key = _key(REF);
        uint256 mgrBefore = usdc.balanceOf(manager);
        uint256 custBefore = usdc.balanceOf(customer);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit RetempoEscrow.ArbitratorAccepted(key, customer, arb, true);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.EscrowFunded(key, manager, AMOUNT, uint40(T0), uint40(T0 + DURATION), true);
        vm.prank(manager);
        assertEq(escrow.fundFromManager(REF, merchant, customer, AMOUNT, DURATION, arb, true), key);
        assertEq(usdc.balanceOf(manager), mgrBefore - AMOUNT);
        assertEq(usdc.balanceOf(customer), custBefore);
        assertEq(escrow.totalLocked(), AMOUNT);
        assertEq(uint8(_e(key).status), uint8(RetempoEscrow.Status.Active));
        assertTrue(_e(key).customerMayRefundUnvested);
    }

    function test_FundFromManager_OnlyManager() public {
        address[4] memory callers = [stranger, merchant, customer, admin];
        for (uint256 i; i < 4; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Unauthorized.selector);
            escrow.fundFromManager(REF, merchant, customer, AMOUNT, DURATION, arb, false);
        }
    }

    function test_FundFromManager_DuplicateAndPausedRevert() public {
        vm.prank(manager);
        escrow.fundFromManager(REF, merchant, customer, AMOUNT, DURATION, arb, false);
        vm.prank(manager);
        vm.expectRevert(RetempoEscrow.EscrowExists.selector);
        escrow.fundFromManager(REF, merchant, customer, AMOUNT, DURATION, arb, false);
        vm.prank(pauser);
        escrow.pause();
        vm.prank(manager);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.fundFromManager(REF2, merchant, customer, AMOUNT, DURATION, arb, false);
    }

    // ───────────────────────── vesting ─────────────────────────

    function test_Vesting_Boundaries() public {
        bytes32 key = _create(REF, AMOUNT, DURATION, false);
        assertEq(escrow.vestedAmount(key), 0, "pending: nothing vests");
        assertEq(escrow.claimableAmount(key), 0);
        _fund(key);
        assertEq(escrow.vestedAmount(key), 0, "at start");
        skip(1);
        assertEq(escrow.vestedAmount(key), _vestedAt(AMOUNT, DURATION, 1));
        vm.warp(T0 + DURATION / 2);
        assertEq(escrow.vestedAmount(key), 45e6, "mid");
        assertEq(escrow.claimableAmount(key), 45e6);
        vm.warp(T0 + DURATION - 1);
        assertEq(escrow.vestedAmount(key), _vestedAt(AMOUNT, DURATION, DURATION - 1));
        assertLt(escrow.vestedAmount(key), AMOUNT);
        vm.warp(T0 + DURATION);
        assertEq(escrow.vestedAmount(key), AMOUNT, "end: exact full vest");
        vm.warp(T0 + DURATION + 365 days);
        assertEq(escrow.vestedAmount(key), AMOUNT, "after end");
    }

    function test_Vesting_RoundsDownAndFullVestIsExact() public {
        bytes32 key = _createAndFund(REF, 10_001, 1 hours, false);
        skip(1);
        assertEq(escrow.vestedAmount(key), 2); // floor(10001 / 3600 = 2.78)
        skip(1799);
        assertEq(escrow.vestedAmount(key), 5000); // floor(5000.5)
        skip(1800);
        assertEq(escrow.vestedAmount(key), 10_001);
        _claim(key);
        assertEq(escrow.withdrawableOf(merchant), 10_001);
        assertEq(escrow.totalLocked(), 0);
    }

    // ───────────────────────── claim ─────────────────────────

    function test_Claim_PartialThenFull() public {
        bytes32 key = _std();
        vm.warp(T0 + 15 days);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.VestedClaimed(key, merchant, 45e6, 45e6);
        _claim(key);
        assertEq(escrow.withdrawableOf(merchant), 45e6);
        assertEq(escrow.totalLocked(), 45e6);
        assertEq(escrow.totalWithdrawable(), 45e6);
        assertEq(escrow.balanceOf(key), 45e6);
        assertEq(uint8(_e(key).status), uint8(RetempoEscrow.Status.Active));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT, "claim only credits the ledger");
        // double claim impossible within same instant
        vm.prank(merchant);
        vm.expectRevert(InvalidAmount.selector);
        escrow.claim(key);
        vm.warp(T0 + DURATION);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit RetempoEscrow.EscrowClosed(key, RetempoEscrow.Outcome.FullyVested);
        _claim(key);
        RetempoEscrow.Escrow memory e = _e(key);
        assertEq(e.claimed, AMOUNT);
        assertEq(uint8(e.status), uint8(RetempoEscrow.Status.Closed));
        assertEq(uint8(e.outcome), uint8(RetempoEscrow.Outcome.FullyVested));
        assertEq(escrow.withdrawableOf(merchant), AMOUNT);
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.InvalidStatus.selector);
        escrow.claim(key);
    }

    function test_Claim_ZeroClaimableReverts() public {
        bytes32 key = _std();
        vm.prank(merchant);
        vm.expectRevert(InvalidAmount.selector);
        escrow.claim(key);
    }

    function test_Claim_OnlyMerchantAndOnlyActive() public {
        bytes32 key = _std();
        skip(10 days);
        vm.prank(customer);
        vm.expectRevert(Unauthorized.selector);
        escrow.claim(key);
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        escrow.claim(key);
        bytes32 pending = _create(REF2, AMOUNT, DURATION, false);
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.InvalidStatus.selector);
        escrow.claim(pending);
    }

    // ───────────────────────── merchantRefund ─────────────────────────

    function test_MerchantRefund_PartialThenVestingContinues() public {
        bytes32 key = _std();
        vm.warp(T0 + 15 days);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.RefundCredited(key, customer, 20e6, RetempoEscrow.Outcome.Refunded, 20e6);
        vm.prank(merchant);
        escrow.merchantRefund(key, 20e6);
        assertEq(escrow.withdrawableOf(customer), 20e6);
        assertEq(escrow.balanceOf(key), 70e6);
        assertEq(escrow.claimableAmount(key), 45e6);
        vm.warp(T0 + DURATION);
        assertEq(escrow.claimableAmount(key), 70e6, "capped at D - R");
        _claim(key);
        assertEq(uint8(_e(key).status), uint8(RetempoEscrow.Status.Closed));
    }

    function test_MerchantRefund_CapsVestedWhenRefundExceedsUnvested() public {
        bytes32 key = _std();
        vm.warp(T0 + 15 days);
        vm.prank(merchant);
        escrow.merchantRefund(key, 80e6);
        assertEq(escrow.claimableAmount(key), 10e6, "cap = D - R binds");
    }

    function test_MerchantRefund_FullRefundCloses() public {
        bytes32 key = _std();
        vm.expectEmit(true, false, false, true, address(escrow));
        emit RetempoEscrow.EscrowClosed(key, RetempoEscrow.Outcome.Refunded);
        vm.prank(merchant);
        escrow.merchantRefund(key, AMOUNT);
        assertEq(uint8(_e(key).status), uint8(RetempoEscrow.Status.Closed));
        assertEq(escrow.withdrawableOf(customer), AMOUNT);
        assertEq(escrow.totalLocked(), 0);
    }

    function test_MerchantRefund_Reverts() public {
        bytes32 key = _std();
        vm.prank(merchant);
        vm.expectRevert(InvalidAmount.selector);
        escrow.merchantRefund(key, 0);
        vm.prank(merchant);
        vm.expectRevert(InvalidAmount.selector);
        escrow.merchantRefund(key, AMOUNT + 1);
        vm.prank(customer);
        vm.expectRevert(Unauthorized.selector);
        escrow.merchantRefund(key, 1);
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        escrow.merchantRefund(key, 1);
    }

    // ───────────────────────── customerRefundUnvested ─────────────────────────

    function test_CustomerRefund_FlagFalseReverts() public {
        bytes32 key = _std();
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.RefundNotAllowed.selector);
        escrow.customerRefundUnvested(key);
    }

    function test_CustomerRefund_OnlyCustomer() public {
        bytes32 key = _stdRefundable();
        vm.prank(merchant);
        vm.expectRevert(Unauthorized.selector);
        escrow.customerRefundUnvested(key);
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        escrow.customerRefundUnvested(key);
    }

    function test_CustomerRefund_MerchantKeepsExactlyWhatVested() public {
        bytes32 key = _stdRefundable();
        vm.warp(T0 + 10 days);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.RefundCredited(key, customer, 60e6, RetempoEscrow.Outcome.Refunded, 60e6);
        vm.prank(customer);
        escrow.customerRefundUnvested(key);
        assertEq(escrow.withdrawableOf(customer), 60e6);
        assertEq(escrow.balanceOf(key), 30e6);
        // vesting has stopped growing: merchant keeps exactly 30
        vm.warp(T0 + DURATION + 1 days);
        assertEq(escrow.claimableAmount(key), 30e6);
        assertEq(uint8(_e(key).status), uint8(RetempoEscrow.Status.Active));
        _claim(key);
        assertEq(uint8(_e(key).status), uint8(RetempoEscrow.Status.Closed));
        assertEq(uint8(_e(key).outcome), uint8(RetempoEscrow.Outcome.FullyVested));
        assertEq(escrow.withdrawableOf(merchant), 30e6);
    }

    function test_CustomerRefund_AtStartRefundsAllAndCloses() public {
        bytes32 key = _stdRefundable();
        vm.prank(customer);
        escrow.customerRefundUnvested(key);
        assertEq(escrow.withdrawableOf(customer), AMOUNT);
        assertEq(uint8(_e(key).status), uint8(RetempoEscrow.Status.Closed));
    }

    function test_CustomerRefund_RoundingFavoursCustomerByLessThanOneUnit() public {
        bytes32 key = _createAndFund(REF, 10_001, 1 hours, true);
        skip(1); // exact vested 2.78 -> floor 2
        vm.prank(customer);
        escrow.customerRefundUnvested(key);
        assertEq(escrow.withdrawableOf(customer), 9_999);
        assertEq(escrow.claimableAmount(key), 2);
    }

    function test_CustomerRefund_NothingUnvestedReverts() public {
        bytes32 key = _stdRefundable();
        skip(DURATION);
        vm.prank(customer);
        vm.expectRevert(InvalidAmount.selector);
        escrow.customerRefundUnvested(key);
        // and a second refund after a first one has nothing left
        bytes32 k2 = _createAndFund(REF2, AMOUNT, DURATION, true);
        skip(1 days);
        vm.prank(customer);
        escrow.customerRefundUnvested(k2);
        vm.prank(customer);
        vm.expectRevert(InvalidAmount.selector);
        escrow.customerRefundUnvested(k2);
    }
}
