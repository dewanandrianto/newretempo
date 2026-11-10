// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console2} from "forge-std/Test.sol";
import {RetempoBase} from "../helpers/RetempoBase.sol";
import {RetempoEscrow} from "../../RetempoEscrow.sol";
import {EscrowInvariantHandler} from "./EscrowInvariantHandler.sol";

/// @notice Handler-driven stateful invariants I1, I2, I3, I4, I8 (+ ledger / frozen / ruling bounds).
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 100
/// forge-config: default.invariant.fail-on-revert = false
contract EscrowInvariantTest is RetempoBase {
    EscrowInvariantHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new EscrowInvariantHandler(escrow, usdc, admin, pauser, configMgr, arbMgr, manager, arb, arb2);
        targetContract(address(h));
        // Arc rejects zero-address transaction senders before EVM execution.
        // Zero-valued function arguments remain fully fuzzed.
        excludeSender(address(0));
        // Handler actions select and prank every protocol actor themselves.
        // The outer dispatcher is not an authorization input; keep it a valid EOA
        // rather than fuzzing Arc-forbidden system/burn transaction senders.
        targetSender(makeAddr("invariant-transaction-sender"));
        _seedStates();
        h.resetOk(); // seeding must not count towards the per-run coverage guard
        _weights();
    }

    uint256 internal constant PENDING_BIT = 7 << 28; // createAndFund seed flag: create but do not fund

    /// @dev Builds a createAndFund seed that decodes to the given merchant / customer / arbitrator indices.
    ///      The handler reads `seed % 3`, `(seed >> 8) % 3`, `(seed >> 16) % 3` (overlapping bytes, and
    ///      256 == 1 mod 3), so the low bytes are solved so each decodes to exactly the wanted index.
    function _s(uint256 m, uint256 c, uint256 a, bool refundable, bool pending) internal pure returns (uint256) {
        uint256 b3 = (refundable ? 0 : 1) + (pending ? 0x70 : 0); // bit 24 = !refundable; bits 28..30 = pending flag
        uint256 b2 = (a + 3 - (b3 % 3)) % 3;
        uint256 b1 = (c + 6 - ((b2 + b3) % 3)) % 3;
        uint256 b0 = (m + 9 - ((b1 + b2 + b3) % 3)) % 3;
        return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    }

    /// @dev Seeds every fuzz run with escrows in different lifecycle states (indices relative to `b`):
    ///      b+0 partially vested + partially claimed, b+1 partially vested, b+2 fresh, b+3 open dispute,
    ///      b+4 open dispute with merchant response, b+5 pending settlement proposal,
    ///      b+6 pending replacement proposal + partial refund, b+7 / b+8 unfunded Pending.
    function _seedStates() internal {
        uint256 b = h.keysLength();
        h.createAndFund(_s(2, 0, 0, true, false), 60e6, 30 days);
        h.createAndFund(_s(0, 0, 0, true, false), 90e6, 30 days);
        vm.warp(block.timestamp + 10 days);
        h.claim(b);
        h.createAndFund(_s(1, 1, 1, false, false), 120e6, 45 days);
        h.createAndFund(_s(2, 2, 2, true, false), 200e6, 40 days);
        h.openDispute(b + 3, 80e6);
        h.createAndFund(_s(1, 0, 0, false, false), 150e6, 40 days);
        h.openDispute(b + 4, 50e6);
        h.respond(b + 4);
        h.createAndFund(_s(0, 1, 1, false, false), 100e6, 20 days);
        h.proposeSettlement(b + 5, uint256(30e6) << 8); // merchant proposes 30e6
        h.createAndFund(_s(1, 2, 2, true, false), 80e6, 30 days);
        h.proposeReplacement(b + 6, 0); // merchant proposes arbs[0]
        h.merchantRefund(b + 6, 10e6);
        h.createAndFund(_s(0, 2, 0, true, true), 70e6, 30 days);
        h.createAndFund(_s(2, 1, 1, false, true), 40e6, 30 days);

        assertEq(h.keysLength(), b + 9, "seed: key count");
        for (uint256 i; i < 7; ++i) {
            assertEq(uint8(escrow.getEscrow(h.keys(b + i)).status), uint8(RetempoEscrow.Status.Active), "seed: active");
        }
        assertEq(uint8(escrow.getEscrow(h.keys(b + 7)).status), uint8(RetempoEscrow.Status.Pending), "seed: pending 7");
        assertEq(uint8(escrow.getEscrow(h.keys(b + 8)).status), uint8(RetempoEscrow.Status.Pending), "seed: pending 8");
        assertGt(escrow.getEscrow(h.keys(b)).claimed, 0, "seed: claimed");
        assertGt(escrow.claimableAmount(h.keys(b + 1)), 0, "seed: partially vested");
        assertEq(uint8(escrow.getEscrow(h.keys(b + 3)).dispute), uint8(RetempoEscrow.DisputeState.Open), "seed: dispute 3");
        assertTrue(escrow.getEscrow(h.keys(b + 4)).merchantResponded, "seed: responded");
        assertEq(escrow.getEscrow(h.keys(b + 5)).settlementProposer, h.merchants(0), "seed: settlement proposal");
        assertEq(escrow.getEscrow(h.keys(b + 6)).replacementProposer, h.merchants(1), "seed: replacement proposal");
        assertGt(escrow.getEscrow(h.keys(b + 6)).refunded, 0, "seed: refunded");
    }

    bytes4[] internal sel;

    function _w(bytes4 s, uint256 n) internal {
        for (uint256 i; i < n; ++i) sel.push(s);
    }

    /// @dev Selector weights (a selector listed N times is N times as likely): core lifecycle actions
    ///      dominate (~73%); config / pause / role actions are rare.
    function _weights() internal {
        _w(h.createAndFund.selector, 6);
        _w(h.fundViaManager.selector, 2);
        _w(h.fundPending.selector, 2);
        _w(h.cancel.selector, 1);
        _w(h.claim.selector, 3);
        _w(h.merchantRefund.selector, 2);
        _w(h.customerRefund.selector, 2);
        _w(h.openDispute.selector, 4);
        _w(h.respond.selector, 3);
        _w(h.resolve.selector, 2);
        _w(h.expire.selector, 3);
        _w(h.proposeSettlement.selector, 2);
        _w(h.acceptSettlement.selector, 3);
        _w(h.proposeReplacement.selector, 2);
        _w(h.acceptReplacement.selector, 2);
        _w(h.withdraw.selector, 3);
        _w(h.withdrawToPayout.selector, 2);
        _w(h.setPayout.selector, 1);
        _w(h.warp.selector, 5);
        _w(h.donate.selector, 1);
        _w(h.pause.selector, 1);
        _w(h.unpause.selector, 2);
        _w(h.setMinAmount.selector, 1);
        _w(h.setMaxEscrowAmount.selector, 1);
        _w(h.setMaxAggregateExposure.selector, 1);
        _w(h.setResponseWindow.selector, 1);
        _w(h.setResolutionTimeout.selector, 1);
        _w(h.addArbitrator.selector, 1);
        _w(h.removeArbitrator.selector, 1);
        _w(h.toggleConflict.selector, 1);
        _w(h.roleMisuse.selector, 1);
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    // ───────────────────────── invariants ─────────────────────────

    /// I1: token balance covers locked + withdrawable; totalLocked == sum of per-escrow B.
    function invariant_I1_Solvency() public view {
        uint256 locked = escrow.totalLocked();
        uint256 wd = escrow.totalWithdrawable();
        assertGe(usdc.balanceOf(address(escrow)), locked + wd, "USDC < locked + withdrawable");
        uint256 sumB;
        uint256 n = h.keysLength();
        for (uint256 i; i < n; ++i) sumB += escrow.balanceOf(h.keys(i));
        assertEq(sumB, locked, "totalLocked != sum(B)");
    }

    /// I2: claimed <= min(vestedAdj, D - R - A - frozen) for every escrow.
    function invariant_I2_ClaimsWithinVestedEligibleBalance() public view {
        uint256 n = h.keysLength();
        for (uint256 i; i < n; ++i) {
            bytes32 k = h.keys(i);
            RetempoEscrow.Escrow memory e = escrow.getEscrow(k);
            uint256 vested = escrow.vestedAmount(k);
            uint256 adj = vested > e.carvedVested ? vested - e.carvedVested : 0;
            uint256 cap = uint256(e.amount) - e.refunded - e.awarded - e.frozen;
            assertLe(e.claimed, adj < cap ? adj : cap, "claimed exceeds eligible vested balance");
        }
    }

    /// I3: R <= D - C - A (refunds never exceed the refundable balance).
    function invariant_I3_RefundsWithinRefundableBalance() public view {
        uint256 n = h.keysLength();
        for (uint256 i; i < n; ++i) {
            RetempoEscrow.Escrow memory e = escrow.getEscrow(h.keys(i));
            assertLe(uint256(e.refunded), uint256(e.amount) - e.claimed - e.awarded, "R > D - C - A");
        }
    }

    /// I4: C + A + R <= D, == D when Closed; Active implies something still held.
    function invariant_I4_AllocationBoundedAndExactWhenClosed() public view {
        uint256 n = h.keysLength();
        for (uint256 i; i < n; ++i) {
            RetempoEscrow.Escrow memory e = escrow.getEscrow(h.keys(i));
            uint256 spent = uint256(e.claimed) + e.awarded + e.refunded;
            assertLe(spent, e.amount, "C+A+R > D");
            if (e.status == RetempoEscrow.Status.Closed) {
                assertEq(spent, e.amount, "Closed but not fully allocated");
                assertEq(e.frozen, 0);
                assertTrue(e.outcome != RetempoEscrow.Outcome.None);
            } else if (e.status == RetempoEscrow.Status.Active) {
                assertLt(spent, e.amount, "Active but fully allocated");
            } else {
                assertEq(spent, 0, "unfunded escrow has allocations");
            }
        }
    }

    /// I8: no role-holder (or any non-withdraw) sequence reduces credit/B or moves USDC;
    ///     total USDC outflow equals the sum of Withdrawn event amounts.
    function invariant_I8_RolesNeverTouchFundsAndOutflowEqualsWithdrawn() public view {
        assertFalse(h.roleViolation(), "role-holder action changed credit/B/USDC");
        assertFalse(h.ledgerViolation(), "credit or B decreased / USDC left outside withdraw");
        assertFalse(h.misuseSucceeded(), "wrong-role call succeeded");
        assertEq(h.ghostIn() - usdc.balanceOf(address(escrow)), h.ghostWithdrawn(), "outflow != sum(Withdrawn)");
    }

    /// Ledger sum equals totalWithdrawable; every credit ever made is either pending or withdrawn.
    function invariant_LedgerSumsAndCreditConservation() public view {
        uint256 sum;
        for (uint256 i; i < h.accountsLength(); ++i) sum += escrow.withdrawableOf(h.accounts(i));
        assertEq(sum, escrow.totalWithdrawable(), "sum(withdrawable) != totalWithdrawable");
        uint256 credited;
        for (uint256 i; i < h.keysLength(); ++i) {
            RetempoEscrow.Escrow memory e = escrow.getEscrow(h.keys(i));
            credited += uint256(e.claimed) + e.awarded + e.refunded;
        }
        assertEq(credited, escrow.totalWithdrawable() + h.ghostWithdrawn(), "credits != ledger + withdrawn");
    }

    /// frozen <= B everywhere; frozen only while a dispute is Open.
    function invariant_FrozenWithinBalance() public view {
        uint256 n = h.keysLength();
        for (uint256 i; i < n; ++i) {
            bytes32 k = h.keys(i);
            RetempoEscrow.Escrow memory e = escrow.getEscrow(k);
            assertLe(e.frozen, escrow.balanceOf(k), "frozen > B");
            if (e.frozen > 0) assertEq(uint8(e.dispute), uint8(RetempoEscrow.DisputeState.Open));
        }
    }

    /// Arbitrator rulings never exceed frozen funds and split them exactly.
    function invariant_RulingsNeverExceedFrozen() public view {
        assertFalse(h.rulingViolation(), "ruling exceeded frozen or mis-split");
    }

    /// Optional coverage print: INV_LOG=true forge test ... --match-test afterInvariant is not needed;
    /// set env to print the per-action success counters after each run.
    function afterInvariant() public view {
        if (vm.envOr("INV_LOG", false)) {
            string memory s;
            for (uint256 i; i < 33; ++i) s = string.concat(s, vm.toString(h.ok(i)), ",");
            console2.log("ok-counts", s);
        }
        // Coverage guard (every run): the counters were zeroed after seeding in setUp, so these count only
        // fuzzer-driven successes. A run that never created+funded an escrow or never exercised a core
        // lifecycle action would pass the invariants vacuously, so it fails here instead.
        require(h.ok(0) > 0 && h.ok(1) > 0, "coverage: createAndFund never succeeded in this run");
        require(
            h.ok(5) + h.ok(6) + h.ok(7) + h.ok(8) > 0,
            "coverage: none of claim/merchantRefund/customerRefund/openDispute succeeded in this run"
        );
    }

    // ───────────────────────── handler smoke (proves actions really execute) ─────────────────────────

    function test_HandlerSmoke_EveryActionSucceedsAtLeastOnce() public {
        // lifecycle paths (setUp already seeded keys; `b` is the first key created by this test)
        uint256 b = h.keysLength();
        h.createAndFund(0, 90e6, 30 days);
        h.warp(10 days);
        h.claim(b);
        h.merchantRefund(b, 0);
        h.customerRefund(b);
        h.createAndFund(1, 90e6, 30 days);
        h.openDispute(b + 1, 5);
        h.respond(b + 1);
        h.resolve(b + 1, 0);
        h.createAndFund(2, 90e6, 30 days);
        h.openDispute(b + 2, 5);
        h.warp(25 days);
        h.warp(25 days);
        h.expire(b + 2, 0);
        h.createAndFund(3, 90e6, 30 days);
        h.proposeSettlement(b + 3, 0);
        h.acceptSettlement(b + 3, 0);
        h.createAndFund(4, 90e6, 30 days);
        h.proposeReplacement(b + 4, 256);
        h.acceptReplacement(b + 4);
        h.withdraw(0);
        h.withdrawToPayout(1, 0);
        h.setPayout(0);
        h.donate(1);
        h.fundViaManager(0, 90e6, 30 days);
        // role holders
        h.pause(0);
        h.unpause();
        h.setMinAmount(5);
        h.setMaxEscrowAmount(type(uint256).max);
        h.setResponseWindow(2 days);
        h.setResolutionTimeout(40 days);
        h.addArbitrator(0);
        h.removeArbitrator(2);
        h.toggleConflict(2);
        h.toggleConflict(2 | (1 << 16));
        for (uint256 i; i < 6; ++i) h.roleMisuse(i);
        // config clamps keep the system usable: 0 / max map into the sane ranges
        h.setMaxAggregateExposure(0); // -> 5_000e6
        h.setMaxAggregateExposure(type(uint256).max); // -> 100_000e6
        // pending path: created-but-unfunded escrows, then cancel / late fund
        h.createAndFund(5 | PENDING_BIT, 500e6, 30 days);
        h.cancel(h.keysLength() - 1);
        h.createAndFund(6 | PENDING_BIT, 500e6, 30 days);
        h.fundPending(h.keysLength() - 1);

        for (uint256 i; i < 33; ++i) assertGt(h.ok(i), 0, string.concat("action never succeeded: ", vm.toString(i)));
        assertFalse(h.roleViolation());
        assertFalse(h.ledgerViolation());
        assertFalse(h.rulingViolation());
        assertFalse(h.misuseSucceeded());
        invariant_I1_Solvency();
        invariant_I2_ClaimsWithinVestedEligibleBalance();
        invariant_I3_RefundsWithinRefundableBalance();
        invariant_I4_AllocationBoundedAndExactWhenClosed();
        invariant_I8_RolesNeverTouchFundsAndOutflowEqualsWithdrawn();
        invariant_LedgerSumsAndCreditConservation();
        invariant_FrozenWithinBalance();
    }
}
