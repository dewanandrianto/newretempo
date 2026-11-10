// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RetempoBase} from "./helpers/RetempoBase.sol";
import {RetempoEscrow} from "../RetempoEscrow.sol";
import {Unauthorized, InvalidAmount, ZeroAddress} from "../interfaces/RetempoErrors.sol";

/// @notice Unit tests: partial disputes, response/resolve/expire, settlement, arbitrator replacement.
contract RetempoEscrowDisputeTest is RetempoBase {
    bytes32 internal key;

    function setUp() public override {
        super.setUp();
        key = _std();
    }

    // ───────────────────────── worked example (design §8) ─────────────────────────

    function test_WorkedExample_Section8() public {
        vm.warp(T0 + 10 days);
        _claim(key); // vested 30 -> claimed 30
        assertEq(_e(key).claimed, 30e6);
        vm.warp(T0 + 12 days); // vested 36
        assertEq(escrow.vestedAmount(key), 36e6);
        assertEq(escrow.claimableAmount(key), 6e6);
        assertEq(escrow.balanceOf(key), 60e6);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit RetempoEscrow.DisputeOpened(key, customer, arb, 20e6, 6e6, HASH, T0 + 12 days + 7 days, T0 + 12 days + 30 days);
        _dispute(key, 20e6);
        RetempoEscrow.Escrow memory e = _e(key);
        assertEq(e.frozen, 20e6);
        assertEq(e.carvedVested, 6e6); // Xv = min(20, 6)
        assertEq(escrow.claimableAmount(key), 0); // E = min(36-6, 90-20) = 30 = C
        assertEq(escrow.freeBalanceOf(key), 40e6);

        vm.warp(T0 + 30 days); // vested adj = 90 - 6 = 84, cap = 70
        assertEq(escrow.claimableAmount(key), 40e6);
        _claim(key);
        assertEq(_e(key).claimed, 70e6);
        assertEq(escrow.balanceOf(key), 20e6);
        assertEq(uint8(_e(key).status), uint8(RetempoEscrow.Status.Active));

        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.DisputeResolved(key, arb, 8e6, 12e6, HASH);
        _resolve(key, 8e6);
        e = _e(key);
        assertEq(e.claimed, 70e6);
        assertEq(e.awarded, 8e6);
        assertEq(e.refunded, 12e6);
        assertEq(e.frozen, 0);
        assertEq(uint8(e.status), uint8(RetempoEscrow.Status.Closed));
        assertEq(uint8(e.outcome), uint8(RetempoEscrow.Outcome.Resolved));
        assertEq(escrow.withdrawableOf(merchant), 78e6);
        assertEq(escrow.withdrawableOf(customer), 12e6);
        assertEq(escrow.totalLocked(), 0);
        assertEq(escrow.totalWithdrawable(), AMOUNT);
    }

    // ───────────────────────── openDispute ─────────────────────────

    function test_Open_UndisputedVestedFundsStayClaimable() public {
        vm.warp(T0 + 15 days); // vested 45, unclaimed 45
        _dispute(key, 10e6);
        assertEq(_e(key).carvedVested, 10e6);
        assertEq(escrow.claimableAmount(key), 35e6);
        _claim(key);
        assertEq(escrow.withdrawableOf(merchant), 35e6);
        assertEq(escrow.balanceOf(key), 55e6);
        assertEq(escrow.freeBalanceOf(key), 45e6);
    }

    function test_Open_FreeKeepsVestingAndNothingCarvedAtStart() public {
        _dispute(key, 20e6);
        assertEq(_e(key).carvedVested, 0);
        vm.warp(T0 + 15 days);
        assertEq(escrow.claimableAmount(key), 45e6);
        vm.warp(T0 + DURATION);
        assertEq(escrow.claimableAmount(key), 70e6); // cap = D - X
    }

    function test_Open_CarvedCappedByClaimableWhenDisputeLarger() public {
        vm.warp(T0 + 15 days);
        _claim(key); // C = 45, claimable 0
        _dispute(key, 45e6); // whole remaining balance
        RetempoEscrow.Escrow memory e = _e(key);
        assertEq(e.carvedVested, 0);
        assertEq(escrow.freeBalanceOf(key), 0);
        vm.warp(T0 + DURATION);
        assertEq(escrow.claimableAmount(key), 0);
    }

    function test_Open_Reverts() public {
        vm.prank(merchant);
        vm.expectRevert(Unauthorized.selector);
        escrow.openDispute(key, 1e6, HASH);
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        escrow.openDispute(key, 1e6, HASH);
        vm.prank(customer);
        vm.expectRevert(InvalidAmount.selector);
        escrow.openDispute(key, 0, HASH);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(RetempoEscrow.AmountTooLarge.selector, uint256(AMOUNT + 1), uint256(AMOUNT)));
        escrow.openDispute(key, AMOUNT + 1, HASH);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.InvalidEvidence.selector);
        escrow.openDispute(key, 1e6, bytes32(0));
        bytes32 pending = _create(keccak256("p"), AMOUNT, DURATION, false);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.InvalidStatus.selector);
        escrow.openDispute(pending, 1e6, HASH);
    }

    function test_Open_OnlyOneDisputePerEscrowEvenAfterResolution() public {
        _dispute(key, 10e6);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.InvalidDispute.selector);
        escrow.openDispute(key, 1e6, HASH);
        skip(8 days);
        _resolve(key, 0);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.InvalidDispute.selector);
        escrow.openDispute(key, 1e6, HASH);
    }

    // ───────────────────────── respondToDispute ─────────────────────────

    function test_Respond_WindowBoundaryOnceOnlyMerchant() public {
        _dispute(key, 10e6);
        vm.prank(customer);
        vm.expectRevert(Unauthorized.selector);
        escrow.respondToDispute(key, HASH);
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        escrow.respondToDispute(key, HASH);
        vm.warp(T0 + 7 days); // exactly the deadline: still allowed
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.DisputeResponded(key, merchant, bytes32(0));
        vm.prank(merchant);
        escrow.respondToDispute(key, bytes32(0)); // zero hash allowed
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.AlreadyResponded.selector);
        escrow.respondToDispute(key, HASH);
    }

    function test_Respond_AfterDeadlineAndWithoutDisputeReverts() public {
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.InvalidDispute.selector);
        escrow.respondToDispute(key, HASH);
        _dispute(key, 10e6);
        vm.warp(T0 + 7 days + 1);
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.ResponseWindowEnded.selector);
        escrow.respondToDispute(key, HASH);
    }

    // ───────────────────────── resolveDispute ─────────────────────────

    function test_Resolve_OnlyAssignedArbitrator() public {
        _dispute(key, 10e6);
        skip(8 days);
        address[5] memory callers = [arb2, merchant, customer, stranger, admin];
        for (uint256 i; i < 5; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Unauthorized.selector);
            escrow.resolveDispute(key, 0, HASH);
        }
    }

    function test_Resolve_WaitsForResponseOrWindow() public {
        _dispute(key, 10e6);
        vm.prank(arb);
        vm.expectRevert(RetempoEscrow.ResponseWindowOpen.selector);
        escrow.resolveDispute(key, 0, HASH);
        vm.warp(T0 + 7 days); // == deadline, not responded
        vm.prank(arb);
        vm.expectRevert(RetempoEscrow.ResponseWindowOpen.selector);
        escrow.resolveDispute(key, 0, HASH);
        vm.warp(T0 + 7 days + 1);
        _resolve(key, 0);
        assertEq(uint8(_e(key).dispute), uint8(RetempoEscrow.DisputeState.Resolved));
    }

    function test_Resolve_ImmediatelyAfterMerchantResponse() public {
        _dispute(key, 10e6);
        vm.prank(merchant);
        escrow.respondToDispute(key, HASH);
        _resolve(key, 10e6);
        assertEq(escrow.withdrawableOf(merchant), 10e6);
        assertEq(escrow.withdrawableOf(customer), 0);
        // free funds untouched: escrow stays Active with B = 80
        assertEq(escrow.balanceOf(key), 80e6);
        assertEq(uint8(_e(key).status), uint8(RetempoEscrow.Status.Active));
    }

    function test_Resolve_RulingAboveFrozenReverts() public {
        _dispute(key, 10e6);
        skip(8 days);
        vm.prank(arb);
        vm.expectRevert(abi.encodeWithSelector(RetempoEscrow.AmountTooLarge.selector, uint256(10e6 + 1), uint256(10e6)));
        escrow.resolveDispute(key, 10e6 + 1, HASH);
    }

    function test_Resolve_CustomerGetsAllWhenRulingZero() public {
        _dispute(key, 25e6);
        skip(8 days);
        _resolve(key, 0);
        assertEq(escrow.withdrawableOf(customer), 25e6);
        assertEq(escrow.withdrawableOf(merchant), 0);
    }

    function test_Resolve_TwiceReverts() public {
        _dispute(key, 10e6);
        skip(8 days);
        _resolve(key, 1);
        vm.prank(arb);
        vm.expectRevert(RetempoEscrow.InvalidDispute.selector);
        escrow.resolveDispute(key, 0, HASH);
        vm.prank(arb);
        vm.expectRevert(RetempoEscrow.InvalidStatus.selector); // unknown key
        escrow.resolveDispute(keccak256("nokey"), 0, HASH);
    }

    function test_Resolve_RevertsIfArbitratorRemovedOrConflicted() public {
        _dispute(key, 10e6);
        skip(8 days);
        vm.prank(arbMgr);
        escrow.removeArbitrator(arb);
        vm.prank(arb);
        vm.expectRevert(RetempoEscrow.ArbitratorNotAllowed.selector);
        escrow.resolveDispute(key, 0, HASH);
        vm.prank(arbMgr);
        escrow.addArbitrator(arb);
        bytes32 role = escrow.ARBITRATOR_MANAGER_ROLE();
        vm.prank(admin);
        escrow.grantRole(role, arb);
        vm.prank(arb);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.resolveDispute(key, 0, HASH);
        // timeout split still available
        vm.warp(T0 + 30 days);
        escrow.expireDispute(key);
        assertEq(uint8(_e(key).dispute), uint8(RetempoEscrow.DisputeState.Resolved));
    }

    // ───────────────────────── expireDispute ─────────────────────────

    function test_Expire_SplitsByVestedAtOpen() public {
        vm.warp(T0 + 15 days); // c0 = 45
        _dispute(key, 30e6); // carved 30
        uint256 openedAt = block.timestamp;
        vm.warp(openedAt + 30 days - 1);
        vm.expectRevert(RetempoEscrow.TimeoutNotReached.selector);
        escrow.expireDispute(key);
        vm.warp(openedAt + 30 days);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.DisputeExpired(key, stranger, 30e6, 0);
        vm.prank(stranger);
        escrow.expireDispute(key);
        assertEq(escrow.withdrawableOf(merchant), 30e6);
        assertEq(escrow.withdrawableOf(customer), 0);
        assertEq(uint8(_e(key).dispute), uint8(RetempoEscrow.DisputeState.Resolved));
    }

    function test_Expire_CustomerGetsUnvestedPortion() public {
        vm.warp(T0 + 3 days); // vested 9
        _dispute(key, 20e6); // carved 9, customer 11
        vm.warp(T0 + 3 days + 30 days);
        escrow.expireDispute(key);
        assertEq(escrow.withdrawableOf(merchant), 9e6);
        assertEq(escrow.withdrawableOf(customer), 11e6);
    }

    function test_Expire_NoDisputeReverts() public {
        vm.expectRevert(RetempoEscrow.InvalidDispute.selector);
        escrow.expireDispute(key);
    }

    // ───────────────────────── settlement ─────────────────────────

    function test_Settlement_DisputeScopedSplitsOnlyFrozen() public {
        vm.warp(T0 + 15 days);
        _dispute(key, 30e6);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.SettlementProposed(key, merchant, 12e6, 30e6, 1);
        vm.prank(merchant);
        escrow.proposeSettlement(key, 12e6);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.SettlementAccepted(key, customer, 12e6, 18e6, 1, true);
        vm.prank(customer);
        escrow.acceptSettlement(key, 12e6, 1);
        assertEq(escrow.withdrawableOf(merchant), 12e6);
        assertEq(escrow.withdrawableOf(customer), 18e6);
        assertEq(escrow.balanceOf(key), 60e6);
        assertEq(_e(key).frozen, 0);
        assertEq(uint8(_e(key).status), uint8(RetempoEscrow.Status.Active));
        assertEq(uint8(_e(key).dispute), uint8(RetempoEscrow.DisputeState.Resolved));
    }

    function test_Settlement_FullScopeClosesEscrow() public {
        vm.warp(T0 + 15 days);
        vm.prank(customer);
        escrow.proposeSettlement(key, 50e6);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.SettlementAccepted(key, merchant, 50e6, 40e6, 1, false);
        vm.prank(merchant);
        escrow.acceptSettlement(key, 50e6, 1);
        assertEq(escrow.withdrawableOf(merchant), 50e6);
        assertEq(escrow.withdrawableOf(customer), 40e6);
        assertEq(uint8(_e(key).status), uint8(RetempoEscrow.Status.Closed));
        assertEq(uint8(_e(key).outcome), uint8(RetempoEscrow.Outcome.Settled));
        assertEq(escrow.totalLocked(), 0);
    }

    function test_Settlement_ScopeChangedByClaimReverts() public {
        vm.prank(customer);
        escrow.proposeSettlement(key, 10e6); // scope = B = 90
        vm.warp(T0 + 15 days);
        _claim(key); // B -> 45
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.SettlementScopeChanged.selector);
        escrow.acceptSettlement(key, 10e6, 1);
    }

    function test_Settlement_ScopeChangedByMerchantRefundReverts() public {
        vm.prank(customer);
        escrow.proposeSettlement(key, 0);
        vm.prank(merchant);
        escrow.merchantRefund(key, 10e6);
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.SettlementScopeChanged.selector);
        escrow.acceptSettlement(key, 0, 1);
    }

    function test_Settlement_ProposalErrors() public {
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(RetempoEscrow.AmountTooLarge.selector, uint256(AMOUNT + 1), uint256(AMOUNT)));
        escrow.proposeSettlement(key, AMOUNT + 1);
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        escrow.proposeSettlement(key, 1);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.ProposalMismatch.selector); // nothing proposed
        escrow.acceptSettlement(key, 1, 1);
        vm.prank(merchant);
        escrow.proposeSettlement(key, 5e6);
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        escrow.acceptSettlement(key, 5e6, 1);
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.ProposalMismatch.selector); // proposer cannot self-accept
        escrow.acceptSettlement(key, 5e6, 1);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.ProposalMismatch.selector); // wrong amount
        escrow.acceptSettlement(key, 6e6, 1);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.ProposalMismatch.selector); // wrong id
        escrow.acceptSettlement(key, 5e6, 2);
    }

    function test_Settlement_StaleIdAfterReplacement() public {
        vm.prank(merchant);
        escrow.proposeSettlement(key, 5e6); // id 1
        vm.prank(customer);
        escrow.proposeSettlement(key, 7e6); // id 2 replaces
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.ProposalMismatch.selector);
        escrow.acceptSettlement(key, 5e6, 1);
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.ProposalMismatch.selector);
        escrow.acceptSettlement(key, 7e6, 1);
        vm.prank(merchant);
        escrow.acceptSettlement(key, 7e6, 2);
        assertEq(escrow.withdrawableOf(merchant), 7e6);
        assertEq(escrow.withdrawableOf(customer), 83e6);
    }

    function test_Settlement_ClearedByDisputeOpenAndByResolution() public {
        vm.prank(customer);
        escrow.proposeSettlement(key, 5e6);
        _dispute(key, 10e6); // clears the full-scope proposal
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.ProposalMismatch.selector);
        escrow.acceptSettlement(key, 5e6, 1);
        vm.prank(merchant);
        escrow.proposeSettlement(key, 4e6); // dispute-scoped, id 2
        skip(8 days);
        _resolve(key, 0);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.ProposalMismatch.selector);
        escrow.acceptSettlement(key, 4e6, 2);
    }

    function test_Settlement_NotActiveReverts() public {
        vm.prank(merchant);
        escrow.merchantRefund(key, AMOUNT); // closes
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.InvalidStatus.selector);
        escrow.proposeSettlement(key, 0);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.InvalidStatus.selector);
        escrow.acceptSettlement(key, 0, 1);
    }

    // ───────────────────────── arbitrator replacement ─────────────────────────

    function test_Replacement_MutualConsent() public {
        vm.expectEmit(true, true, true, false, address(escrow));
        emit RetempoEscrow.ArbitratorReplacementProposed(key, merchant, arb2);
        vm.prank(merchant);
        escrow.proposeArbitratorReplacement(key, arb2);
        vm.expectEmit(true, true, true, false, address(escrow));
        emit RetempoEscrow.ArbitratorReplaced(key, arb, arb2);
        vm.prank(customer);
        escrow.acceptArbitratorReplacement(key, arb2);
        assertEq(_e(key).arbitrator, arb2);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.ProposalMismatch.selector); // cleared
        escrow.acceptArbitratorReplacement(key, arb2);
    }

    function test_Replacement_ProposalErrors() public {
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        escrow.proposeArbitratorReplacement(key, arb2);
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        escrow.acceptArbitratorReplacement(key, arb2);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.ProposalMismatch.selector);
        escrow.acceptArbitratorReplacement(key, arb2);
        vm.prank(merchant);
        escrow.proposeArbitratorReplacement(key, arb2);
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.ProposalMismatch.selector); // self-accept
        escrow.acceptArbitratorReplacement(key, arb2);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.ProposalMismatch.selector); // different candidate
        escrow.acceptArbitratorReplacement(key, arb);
    }

    function test_Replacement_ConflictedOrUnlistedCandidateReverts() public {
        vm.startPrank(merchant);
        vm.expectRevert(ZeroAddress.selector);
        escrow.proposeArbitratorReplacement(key, address(0));
        vm.expectRevert(RetempoEscrow.ArbitratorNotAllowed.selector);
        escrow.proposeArbitratorReplacement(key, stranger);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.proposeArbitratorReplacement(key, merchant);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.proposeArbitratorReplacement(key, customer);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.proposeArbitratorReplacement(key, admin);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.proposeArbitratorReplacement(key, pauser);
        vm.stopPrank();
    }

    function test_Replacement_CandidateRecheckedAtAcceptance() public {
        vm.prank(merchant);
        escrow.proposeArbitratorReplacement(key, arb2);
        vm.prank(arbMgr);
        escrow.removeArbitrator(arb2);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.ArbitratorNotAllowed.selector);
        escrow.acceptArbitratorReplacement(key, arb2);
        vm.prank(arbMgr);
        escrow.addArbitrator(arb2);
        bytes32 role = escrow.PAUSER_ROLE();
        vm.prank(admin);
        escrow.grantRole(role, arb2);
        vm.prank(customer);
        vm.expectRevert(RetempoEscrow.ConflictedArbitrator.selector);
        escrow.acceptArbitratorReplacement(key, arb2);
    }

    function test_Replacement_DuringDisputeNewArbitratorResolves() public {
        _dispute(key, 10e6);
        skip(8 days);
        vm.prank(customer);
        escrow.proposeArbitratorReplacement(key, arb2);
        vm.prank(merchant);
        escrow.acceptArbitratorReplacement(key, arb2);
        vm.prank(arb);
        vm.expectRevert(Unauthorized.selector);
        escrow.resolveDispute(key, 0, HASH);
        vm.prank(arb2);
        escrow.resolveDispute(key, 3e6, HASH);
        assertEq(escrow.withdrawableOf(merchant), 3e6);
        assertEq(escrow.withdrawableOf(customer), 7e6);
    }

    function test_Replacement_ClosedEscrowReverts() public {
        vm.prank(merchant);
        escrow.merchantRefund(key, AMOUNT);
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.InvalidStatus.selector);
        escrow.proposeArbitratorReplacement(key, arb2);
    }
}
