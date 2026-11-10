// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RetempoBase} from "./helpers/RetempoBase.sol";
import {RetempoEscrow} from "../RetempoEscrow.sol";
import {InvalidAmount} from "../interfaces/RetempoErrors.sol";

/// @notice Fuzz tests: vesting rounding, refund formulas, dispute carving, random operation sequences.
contract RetempoEscrowFuzzTest is RetempoBase {
    function setUp() public override {
        super.setUp();
        uint256 hardMax = escrow.HARD_MAX_AMOUNT();
        vm.prank(configMgr);
        escrow.setMaxEscrowAmount(hardMax);
        usdc.mint(customer, 1e18);
    }

    function _fundFresh(uint256 d, uint256 dur, bool refundable) internal returns (bytes32 k, uint128 amt, uint32 duration) {
        amt = uint128(bound(d, 10_000, 1e15));
        duration = uint32(bound(dur, 1 hours, 90 days));
        k = _createAndFund(REF, amt, duration, refundable);
    }

    // ───────────────────────── vesting ─────────────────────────

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_VestingRoundingMonotoneAndExactAtEnd(uint256 d, uint256 dur, uint256 t1, uint256 t2) public {
        (bytes32 k, uint128 amt, uint32 duration) = _fundFresh(d, dur, false);
        t1 = bound(t1, 0, uint256(duration) * 2);
        t2 = bound(t2, 0, uint256(duration) * 2);
        if (t1 > t2) (t1, t2) = (t2, t1);

        vm.warp(T0 + t1);
        uint256 v1 = escrow.vestedAmount(k);
        assertLe(v1, amt, "vested <= D");
        assertEq(v1, _vestedAt(amt, duration, t1), "floor pro-rata");
        vm.warp(T0 + t2);
        uint256 v2 = escrow.vestedAmount(k);
        assertLe(v2, amt);
        assertGe(v2, v1, "monotone");

        vm.warp(T0 + duration);
        assertEq(escrow.vestedAmount(k), amt, "exact at end");
        _claim(k);
        assertEq(escrow.withdrawableOf(merchant), amt, "no dust");
        assertEq(escrow.totalLocked(), 0);
        assertEq(uint8(_e(k).status), uint8(RetempoEscrow.Status.Closed));
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_ClaimCreditsExactlyVestedAndNeverMore(uint256 d, uint256 dur, uint256 t1, uint256 t2) public {
        (bytes32 k, uint128 amt, uint32 duration) = _fundFresh(d, dur, false);
        t1 = bound(t1, 1, duration);
        t2 = bound(t2, t1, uint256(duration) + 5 days);
        vm.warp(T0 + t1);
        uint256 v1 = _vestedAt(amt, duration, t1);
        if (v1 == 0) {
            vm.prank(merchant);
            vm.expectRevert(InvalidAmount.selector);
            escrow.claim(k);
        } else {
            _claim(k);
            assertEq(escrow.withdrawableOf(merchant), v1);
        }
        vm.warp(T0 + t2);
        uint256 v2 = _vestedAt(amt, duration, t2);
        if (v2 == v1) {
            vm.prank(merchant);
            vm.expectRevert(); // nothing new (InvalidAmount) or already Closed (InvalidStatus)
            escrow.claim(k);
        } else {
            _claim(k);
        }
        assertEq(escrow.withdrawableOf(merchant), v2);
        assertEq(escrow.withdrawableOf(merchant) + escrow.balanceOf(k), amt);
    }

    // ───────────────────────── refund formulas ─────────────────────────

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_MerchantRefundFormula(uint256 d, uint256 dur, uint256 t, uint256 r) public {
        (bytes32 k, uint128 amt, uint32 duration) = _fundFresh(d, dur, false);
        t = bound(t, 0, uint256(duration) + 1 days);
        r = bound(r, 1, amt);
        vm.warp(T0 + t);
        vm.prank(merchant);
        escrow.merchantRefund(k, uint128(r));
        RetempoEscrow.Escrow memory e = _e(k);
        assertEq(e.refunded, r);
        assertEq(escrow.withdrawableOf(customer), r);
        uint256 vested = _vestedAt(amt, duration, t);
        uint256 expectedClaimable = vested < amt - r ? vested : amt - r;
        if (e.status == RetempoEscrow.Status.Closed) {
            assertEq(r, amt);
        } else {
            assertEq(escrow.claimableAmount(k), expectedClaimable, "min(vested, D - R)");
            assertEq(escrow.balanceOf(k), amt - r);
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_CustomerRefundUnvestedFormula(uint256 d, uint256 dur, uint256 t) public {
        (bytes32 k, uint128 amt, uint32 duration) = _fundFresh(d, dur, true);
        t = bound(t, 0, uint256(duration) + 1 days);
        vm.warp(T0 + t);
        uint256 vested = _vestedAt(amt, duration, t);
        if (vested == amt) {
            vm.prank(customer);
            vm.expectRevert(InvalidAmount.selector);
            escrow.customerRefundUnvested(k);
            return;
        }
        vm.prank(customer);
        escrow.customerRefundUnvested(k);
        assertEq(escrow.withdrawableOf(customer), amt - vested, "refund = D - floor(vested)");
        // vesting stops growing: merchant keeps exactly what had vested, forever
        vm.warp(T0 + duration + 30 days);
        assertEq(escrow.claimableAmount(k), vested);
        if (vested > 0) {
            _claim(k);
            assertEq(escrow.withdrawableOf(merchant), vested);
            assertEq(uint8(_e(k).status), uint8(RetempoEscrow.Status.Closed));
        }
        assertEq(escrow.withdrawableOf(customer) + vested, amt);
    }

    // ───────────────────────── disputes ─────────────────────────

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_DisputeCarvingAndConservation(uint256 d, uint256 dur, uint256 t1, uint256 t2, uint256 x, uint256 m, bool doClaim) public {
        (bytes32 k, uint128 amt, uint32 duration) = _fundFresh(d, dur, false);
        t1 = bound(t1, 0, duration);
        t2 = bound(t2, t1, duration);
        vm.warp(T0 + t1);
        if (doClaim && escrow.claimableAmount(k) > 0) _claim(k);
        vm.warp(T0 + t2);
        uint256 b = escrow.balanceOf(k);
        if (b == 0) return;
        x = bound(x, 1, b);
        uint256 c0 = escrow.claimableAmount(k);
        _dispute(k, uint128(x));
        RetempoEscrow.Escrow memory e = _e(k);
        uint256 carved = x < c0 ? x : c0;
        assertEq(e.carvedVested, carved, "Xv = min(X, c0)");
        assertEq(escrow.claimableAmount(k), c0 - carved, "E continuous at open");
        assertEq(escrow.freeBalanceOf(k), b - x);

        // Free funds keep vesting; after the exclusive arbitration deadline only
        // the deterministic timeout allocation is allowed.
        vm.warp(T0 + duration + 8 days);
        uint256 claimedBefore = e.claimed;
        uint256 expectEnd = amt - x < amt - carved ? amt - x : amt - carved;
        assertEq(escrow.claimableAmount(k), expectEnd - claimedBefore);
        m = bound(m, 0, x);
        if (vm.getBlockTimestamp() >= uint256(e.disputedAt) + e.resolutionTimeout) {
            vm.prank(arb);
            vm.expectRevert(RetempoEscrow.ResolutionWindowEnded.selector);
            escrow.resolveDispute(k, uint128(m), HASH);
            assertEq(_e(k).frozen, x, "late ruling cannot mutate frozen funds");
            escrow.expireDispute(k);
            m = carved;
        } else {
            _resolve(k, uint128(m));
        }
        e = _e(k);
        assertEq(e.awarded, m);
        assertEq(e.refunded, x - m);
        assertEq(e.frozen, 0);
        assertEq(uint256(e.claimed) + e.awarded + e.refunded + escrow.balanceOf(k), amt);
        if (escrow.claimableAmount(k) > 0) _claim(k);
        e = _e(k);
        assertEq(uint256(e.claimed) + e.awarded + e.refunded, amt, "all allocated at full vest");
        assertEq(uint8(e.status), uint8(RetempoEscrow.Status.Closed));
        assertEq(escrow.totalLocked(), 0);
        assertEq(escrow.totalWithdrawable(), amt);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_ExpirySplitEqualsCarvedVested(uint256 d, uint256 dur, uint256 t, uint256 x) public {
        (bytes32 k, uint128 amt, uint32 duration) = _fundFresh(d, dur, false);
        t = bound(t, 0, duration);
        vm.warp(T0 + t);
        x = bound(x, 1, amt);
        uint256 c0 = escrow.claimableAmount(k);
        _dispute(k, uint128(x));
        uint256 carved = x < c0 ? x : c0;
        vm.warp(block.timestamp + 30 days);
        vm.prank(stranger);
        escrow.expireDispute(k);
        assertEq(escrow.withdrawableOf(merchant), carved);
        assertEq(escrow.withdrawableOf(customer), x - carved);
    }

    /// forge-config: default.fuzz.runs = 500
    function testFuzz_RulingAboveFrozenAlwaysReverts(uint256 x, uint256 extra) public {
        x = bound(x, 1, AMOUNT);
        extra = bound(extra, 1, type(uint64).max);
        bytes32 k = _std();
        _dispute(k, uint128(x));
        skip(8 days);
        vm.prank(arb);
        vm.expectRevert(abi.encodeWithSelector(RetempoEscrow.AmountTooLarge.selector, x + extra, x));
        escrow.resolveDispute(k, uint128(x + extra), HASH);
    }

    // ───────────────────────── settlement ─────────────────────────

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_FullScopeSettlementConserves(uint256 d, uint256 dur, uint256 t, uint256 m, bool customerProposes) public {
        (bytes32 k, uint128 amt, uint32 duration) = _fundFresh(d, dur, false);
        t = bound(t, 0, duration);
        vm.warp(T0 + t);
        m = bound(m, 0, amt);
        address proposer = customerProposes ? customer : merchant;
        address acceptor = customerProposes ? merchant : customer;
        vm.prank(proposer);
        escrow.proposeSettlement(k, uint128(m));
        vm.prank(acceptor);
        escrow.acceptSettlement(k, uint128(m), 1);
        assertEq(escrow.withdrawableOf(merchant), m);
        assertEq(escrow.withdrawableOf(customer), amt - m);
        assertEq(uint8(_e(k).status), uint8(RetempoEscrow.Status.Closed));
        assertEq(escrow.totalLocked(), 0);
    }

    // ───────────────────────── random operation sequences ─────────────────────────

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_RandomSequencePreservesAccounting(uint256 seed, uint256 d, uint256 dur, bool refundable) public {
        (bytes32 k, uint128 amt,) = _fundFresh(d, dur, refundable);
        for (uint256 i; i < 24; ++i) {
            _step(k, uint256(keccak256(abi.encode(seed, i))));
            _check(k, amt);
        }
        // drain: both parties withdraw; funds fully accounted for
        uint256 owed = escrow.totalWithdrawable();
        if (escrow.withdrawableOf(merchant) > 0) {
            vm.prank(merchant);
            escrow.withdraw(merchant);
        }
        if (escrow.withdrawableOf(customer) > 0) {
            vm.prank(customer);
            escrow.withdraw(customer);
        }
        assertEq(escrow.totalWithdrawable(), 0);
        assertEq(usdc.balanceOf(address(escrow)), escrow.totalLocked());
        assertLe(owed, amt);
    }

    function _step(bytes32 k, uint256 r) internal {
        uint256 op = r % 11;
        uint256 v = r >> 8;
        RetempoEscrow.Escrow memory e = _e(k);
        uint256 b = escrow.balanceOf(k);
        if (op == 0) {
            skip(1 + (v % 12 days));
            if (v % 7 == 0) skip(31 days); // occasionally cross the timeout
        } else if (op == 1) {
            vm.prank(merchant);
            try escrow.claim(k) {} catch {}
        } else if (op == 2) {
            vm.prank(merchant);
            try escrow.merchantRefund(k, uint128(1 + (v % (b + 1)))) {} catch {}
        } else if (op == 3) {
            vm.prank(customer);
            try escrow.customerRefundUnvested(k) {} catch {}
        } else if (op == 4) {
            vm.prank(customer);
            try escrow.openDispute(k, uint128(1 + (v % (b + 1))), HASH) {} catch {}
        } else if (op == 5) {
            vm.prank(merchant);
            try escrow.respondToDispute(k, HASH) {} catch {}
        } else if (op == 6) {
            vm.prank(arb);
            try escrow.resolveDispute(k, uint128(v % (uint256(e.frozen) + 1)), HASH) {} catch {}
        } else if (op == 7) {
            vm.prank(stranger);
            try escrow.expireDispute(k) {} catch {}
        } else if (op == 8) {
            uint256 scope = e.frozen > 0 ? e.frozen : b;
            vm.prank(v % 2 == 0 ? merchant : customer);
            try escrow.proposeSettlement(k, uint128(v % (scope + 1))) {} catch {}
        } else if (op == 9) {
            address acceptor = e.settlementProposer == merchant ? customer : merchant;
            vm.prank(acceptor);
            try escrow.acceptSettlement(k, e.settlementMerchantAmount, e.settlementId) {} catch {}
        } else {
            vm.prank(v % 2 == 0 ? merchant : customer);
            try escrow.withdraw(v % 2 == 0 ? merchant : customer) {} catch {}
        }
    }

    function _check(bytes32 k, uint256 d) internal view {
        RetempoEscrow.Escrow memory e = _e(k);
        uint256 spent = uint256(e.claimed) + e.awarded + e.refunded;
        assertLe(spent, d, "C+A+R <= D");
        uint256 b = d - spent;
        assertEq(escrow.balanceOf(k), b, "B = D-C-A-R");
        assertLe(e.frozen, b, "frozen <= B");
        assertEq(escrow.totalLocked(), b);
        assertEq(escrow.withdrawableOf(merchant) + escrow.withdrawableOf(customer), escrow.totalWithdrawable());
        assertEq(usdc.balanceOf(address(escrow)), escrow.totalLocked() + escrow.totalWithdrawable(), "solvent, no excess");
        uint256 vested = escrow.vestedAmount(k);
        uint256 adj = vested > e.carvedVested ? vested - e.carvedVested : 0;
        uint256 cap = d - e.refunded - e.awarded - e.frozen;
        assertLe(e.claimed, adj < cap ? adj : cap, "claims within eligible vested balance");
        if (e.status == RetempoEscrow.Status.Closed) assertEq(b, 0);
        if (e.status == RetempoEscrow.Status.Active) assertGt(b, 0);
    }
}
