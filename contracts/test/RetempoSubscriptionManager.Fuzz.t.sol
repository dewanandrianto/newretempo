// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {RetempoSubscriptionManager} from "../RetempoSubscriptionManager.sol";
import {Unauthorized, AmountOutOfBounds} from "../interfaces/RetempoErrors.sol";
import {RetempoSystemBase} from "./helpers/RetempoSystemBase.sol";

/// @dev Fuzz suite: interval/grace/timestamp arithmetic, caps, limits, actor selection.
contract RetempoSubscriptionManagerFuzzTest is RetempoSystemBase {
    uint256 internal constant MINP = 10_000;
    bytes32 internal planKey;
    bytes32 internal subKey;

    function _excluded(address a) internal view returns (bool) {
        return uint160(a) <= 0xFFFF || a == address(vm) || a == 0x000000000000000000636F6e736F6c652e6c6f67
            || a == address(this) || a == address(mgr) || a == address(escrow) || a == address(usdc) || a == payout
            || a == customer || a == merchant || a == admin || a == pauser || a == configMgr || a == arbMgr;
    }

    function _bad(bytes memory err) internal pure returns (bytes4 sel) {
        if (err.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(err, 0x20))
        }
    }

    // ------------------------------------------------------------ timestamp arithmetic

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_RenewArithmetic(uint32 intervalIn, uint32 graceIn, uint32 delayIn) public {
        uint32 interval = uint32(bound(intervalIn, 1 days, 366 days));
        uint32 grace = uint32(bound(graceIn, 0, interval - 1));
        uint256 delay = bound(delayIn, 0, 1000 days);
        planKey = _plan(PREF, PRICE, interval, 0, grace, 0);
        subKey = _subscribe(planKey);
        uint256 due = T0 + interval;
        assertEq(_sub(subKey).nextChargeAt, due);
        vm.warp(due + delay);
        _renew(subKey);
        uint256 expected = delay <= grace ? due + interval : block.timestamp + interval;
        assertEq(_sub(subKey).nextChargeAt, expected, "next due");
        assertGt(_sub(subKey).nextChargeAt, block.timestamp, "strictly in the future");
        assertEq(_sub(subKey).chargeCount, 2);
        // same period cannot be paid twice
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        mgr.renew(subKey);
        assertEq(usdc.balanceOf(payout), 2 * PRICE);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_RecurringChargeArithmeticAndNoDoublePeriod(uint32 intervalIn, uint32 graceIn, uint32 delayIn) public {
        uint32 interval = uint32(bound(intervalIn, 1 days, 366 days));
        uint32 grace = uint32(bound(graceIn, 0, interval - 1));
        uint256 delay = bound(delayIn, 0, 300 days);
        planKey = _plan(PREF, PRICE, interval, 0, grace, 0);
        subKey = _subscribe(planKey);
        uint256 due = T0 + interval;
        _mandate(subKey, PRICE, 5 * PRICE, T0 + 366 days);
        vm.warp(due + delay);
        if (block.timestamp >= T0 + 366 days) {
            vm.expectRevert(RetempoSubscriptionManager.MandateExpired.selector);
            _charge(subKey);
            return;
        }
        _charge(subKey);
        uint256 expected = delay <= grace ? due + interval : block.timestamp + interval;
        assertEq(_sub(subKey).nextChargeAt, expected);
        assertGt(_sub(subKey).nextChargeAt, block.timestamp);
        assertEq(_man(subKey).spent, PRICE);
        assertEq(_reason(subKey), 5);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        _charge(subKey);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        mgr.renew(subKey);
        assertEq(usdc.balanceOf(payout), 2 * PRICE);
        assertEq(_man(subKey).spent, PRICE);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_CadencePreservedWhenOnTime(uint32 intervalIn, uint32 graceIn, uint256 seed, uint8 nIn) public {
        uint32 interval = uint32(bound(intervalIn, 1 days, 366 days));
        uint32 grace = uint32(bound(graceIn, 0, interval - 1));
        uint256 n = bound(nIn, 1, 12);
        planKey = _plan(PREF, PRICE, interval, 0, grace, 0);
        subKey = _subscribe(planKey);
        for (uint256 i = 1; i <= n; ++i) {
            uint256 jitter = uint256(keccak256(abi.encode(seed, i))) % (uint256(grace) + 1);
            vm.warp(T0 + i * interval + jitter);
            _renew(subKey);
            assertEq(_sub(subKey).nextChargeAt, T0 + (i + 1) * interval, "no drift");
            assertGt(_sub(subKey).nextChargeAt, block.timestamp);
        }
        assertEq(_sub(subKey).chargeCount, n + 1);
        assertEq(usdc.balanceOf(payout), (n + 1) * PRICE);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_TrialArithmetic(uint32 trialIn, uint32 intervalIn) public {
        uint32 trial = uint32(bound(trialIn, 1, 365 days));
        uint32 interval = uint32(bound(intervalIn, 1 days, 366 days));
        planKey = _plan(PREF, PRICE, interval, trial, 0, 0);
        subKey = _subscribe(planKey);
        assertEq(_sub(subKey).nextChargeAt, T0 + trial);
        assertEq(_sub(subKey).chargeCount, 0);
        assertEq(usdc.balanceOf(payout), 0);
        vm.warp(T0 + trial - 1);
        vm.prank(customer);
        vm.expectRevert(RetempoSubscriptionManager.NotDue.selector);
        mgr.renew(subKey);
        vm.warp(T0 + trial);
        _renew(subKey);
        assertEq(_sub(subKey).nextChargeAt, T0 + trial + interval);
        assertEq(usdc.balanceOf(payout), PRICE);
    }

    // ------------------------------------------------------------ random sequences, caps

    function _checkSuccess(RetempoSubscriptionManager.Subscription memory b) internal view {
        RetempoSubscriptionManager.Subscription memory a = _sub(subKey);
        assertGe(block.timestamp, b.nextChargeAt, "paid only when due");
        assertGt(a.nextChargeAt, block.timestamp, "next due strictly in the future");
        assertGt(a.nextChargeAt, b.nextChargeAt, "due strictly advanced (no repeat of a period)");
        assertEq(a.chargeCount, b.chargeCount + 1);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_RandomSequence_CapsNeverExceeded(uint256 seed, uint128 perExtra, uint128 totalIn, uint8 stepsIn) public {
        uint128 per = PRICE + uint128(bound(perExtra, 0, 5 * PRICE));
        uint128 total = uint128(bound(totalIn, per, 6 * uint256(per)));
        (planKey, subKey) = _directSub();
        _mandate(subKey, per, total, T0 + 200 days);
        uint256 successes = 1; // the subscribe payment
        uint256 ghostSpent;
        uint256 steps = bound(stepsIn, 1, 40);
        for (uint256 i; i < steps; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = r % 8;
            RetempoSubscriptionManager.Subscription memory b = _sub(subKey);
            if (op == 0) {
                // jump to (just around) the next due time so payments actually happen
                uint256 target = uint256(b.nextChargeAt) + ((r >> 8) % (uint256(GRACE) + 2));
                if (target > block.timestamp) vm.warp(target);
            } else if (op == 1) {
                vm.warp(block.timestamp + ((r >> 8) % (2 * INTERVAL)));
            } else if (op <= 4) {
                vm.prank(address(uint160(uint256(keccak256(abi.encode(r, "caller"))))));
                try mgr.charge(subKey) {
                    successes++;
                    ghostSpent += PRICE;
                    _checkSuccess(b);
                    assertLe(PRICE, _man(subKey).perChargeCap, "charge within per-charge cap");
                } catch {}
            } else if (op == 5) {
                vm.prank(customer);
                try mgr.renew(subKey) {
                    successes++;
                    _checkSuccess(b);
                } catch {}
            } else if (op == 6) {
                uint128 nper = PRICE + uint128((r >> 32) % (3 * uint256(PRICE)));
                uint128 ntotal = nper + uint128((r >> 64) % (5 * uint256(PRICE)));
                uint40 nexp = uint40(block.timestamp + 1 + ((r >> 96) % 366 days));
                vm.prank(customer);
                try mgr.createMandate(subKey, nper, ntotal, nexp) {
                    ghostSpent = 0;
                } catch {}
            } else {
                vm.prank(customer);
                try mgr.revokeMandate(subKey) {} catch {}
            }
            RetempoSubscriptionManager.Mandate memory m = _man(subKey);
            assertLe(m.spent, m.totalCap, "spent <= totalCap");
            assertEq(m.spent, ghostSpent, "spent tracks recurring only");
            assertEq(_sub(subKey).chargeCount, successes);
            assertEq(usdc.balanceOf(payout), PRICE * successes, "one PRICE per success");
            assertEq(usdc.balanceOf(customer), CUSTOMER_FUNDS - PRICE * successes);
            assertEq(usdc.balanceOf(address(mgr)), 0);
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_TotalCapAllowsExactlyFloorTotalOverPrice(uint128 totalIn) public {
        uint128 total = uint128(bound(totalIn, PRICE, 6 * uint256(PRICE) + PRICE - 1));
        (planKey, subKey) = _directSub();
        _mandate(subKey, PRICE, total, T0 + 300 days);
        uint256 ok;
        for (uint256 i = 1; i <= 8; ++i) {
            vm.warp(T0 + i * INTERVAL);
            try this.chargeExt(subKey) {
                ok++;
            } catch (bytes memory err) {
                assertEq(_bad(err), RetempoSubscriptionManager.TotalCapExceeded.selector);
            }
        }
        assertEq(ok, total / PRICE);
        assertEq(_man(subKey).spent, ok * PRICE);
        assertLe(_man(subKey).spent, total);
    }

    function chargeExt(bytes32 k) external {
        mgr.charge(k);
    }

    // ------------------------------------------------------------ limit and amounts

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_PlanAmountVersusLimit(uint128 amount, uint256 limitIn) public {
        uint256 limit = bound(limitIn, MINP, 1e15);
        _setLimit(limit);
        bool valid = amount >= MINP && amount <= limit;
        vm.prank(merchant);
        try mgr.createPlan(PREF, payout, amount, INTERVAL, 0, GRACE, 0, address(0), false) {
            assertTrue(valid, "accepted an invalid amount");
        } catch (bytes memory err) {
            assertFalse(valid, "rejected a valid amount");
            assertEq(_bad(err), AmountOutOfBounds.selector);
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_AmountsAtLimit(uint256 limitIn) public {
        uint256 limit = bound(limitIn, MINP, 1e15);
        _setLimit(limit);
        usdc.mint(customer, 2e15);
        planKey = _plan(PREF, uint128(limit), INTERVAL, 0, GRACE, 0); // exactly at the limit
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(AmountOutOfBounds.selector, limit + 1, MINP, limit));
        mgr.createPlan(keccak256("over"), payout, uint128(limit + 1), INTERVAL, 0, GRACE, 0, address(0), false);
        subKey = _subscribe(planKey);
        assertEq(usdc.balanceOf(payout), limit);
        if (limit > MINP) {
            _setLimit(limit - 1);
            vm.warp(T0 + INTERVAL);
            vm.prank(customer);
            vm.expectRevert(abi.encodeWithSelector(RetempoSubscriptionManager.PaymentLimitExceeded.selector, limit, limit - 1));
            mgr.renew(subKey);
            assertEq(_sub(subKey).chargeCount, 1);
            _setLimit(limit);
            _renew(subKey);
            assertEq(usdc.balanceOf(payout), 2 * limit);
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_ChargeVersusLoweredLimit(uint256 newLimitIn) public {
        uint256 newLimit = bound(newLimitIn, MINP, 1e15);
        (planKey, subKey) = _directSub();
        _mandate(subKey, PRICE, 3 * PRICE, T0 + 100 days);
        _setLimit(newLimit);
        vm.warp(T0 + INTERVAL);
        if (newLimit >= PRICE) {
            assertEq(_reason(subKey), 0);
            _charge(subKey);
            assertEq(usdc.balanceOf(payout), 2 * PRICE);
        } else {
            assertEq(_reason(subKey), 3);
            vm.expectRevert(abi.encodeWithSelector(RetempoSubscriptionManager.PaymentLimitExceeded.selector, uint256(PRICE), newLimit));
            _charge(subKey);
            assertEq(usdc.balanceOf(payout), PRICE);
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_MandateValidation(uint128 per, uint128 total, uint40 expiry, bool nearBoundary) public {
        (planKey, subKey) = _directSub();
        if (nearBoundary) {
            // concentrate on the exact edges of the expiry window
            expiry = uint40(T0 + (uint256(expiry) % 3) + 366 days - 1);
        }
        bool capsOk = per >= PRICE && total >= per && total <= mgr.HARD_MAX_AMOUNT();
        bool expiryOk = expiry > block.timestamp && uint256(expiry) <= block.timestamp + 366 days;
        vm.prank(customer);
        try mgr.createMandate(subKey, per, total, expiry) {
            assertTrue(capsOk && expiryOk);
            assertEq(_man(subKey).nonce, 1);
            assertEq(_man(subKey).spent, 0);
        } catch (bytes memory err) {
            assertFalse(capsOk && expiryOk);
            bytes4 want = capsOk ? RetempoSubscriptionManager.InvalidExpiry.selector : RetempoSubscriptionManager.InvalidMandateCaps.selector;
            assertEq(_bad(err), want);
            assertEq(_man(subKey).nonce, 0);
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_MandateValidationBounded(uint256 perIn, uint256 totalIn, uint256 expiryOffset) public {
        (planKey, subKey) = _directSub();
        uint256 per = bound(perIn, PRICE - 2, 4 * uint256(PRICE));
        uint256 total = bound(totalIn, per > 0 ? per - 1 : 0, 6 * uint256(PRICE));
        uint256 expiry = T0 + bound(expiryOffset, 0, 367 days);
        bool ok = per >= PRICE && total >= per && expiry > T0 && expiry <= T0 + 366 days;
        vm.prank(customer);
        try mgr.createMandate(subKey, uint128(per), uint128(total), uint40(expiry)) {
            assertTrue(ok, "accepted invalid mandate");
            assertEq(_man(subKey).expiry, expiry);
            assertEq(_man(subKey).perChargeCap, per);
            assertEq(_man(subKey).totalCap, total);
        } catch (bytes memory err) {
            assertFalse(ok, "rejected valid mandate");
            bytes4 want = (per >= PRICE && total >= per) ? RetempoSubscriptionManager.InvalidExpiry.selector : RetempoSubscriptionManager.InvalidMandateCaps.selector;
            assertEq(_bad(err), want);
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_AllowanceAndBalanceBoundaries(uint256 allowIn, uint256 balIn) public {
        (planKey, subKey) = _directSub();
        _mandate(subKey, PRICE, 3 * PRICE, T0 + 100 days);
        vm.warp(T0 + INTERVAL);
        uint256 allowance = bound(allowIn, 0, 3 * uint256(PRICE));
        uint256 bal = bound(balIn, 0, 3 * uint256(PRICE));
        vm.prank(customer);
        usdc.approve(address(mgr), allowance);
        uint256 have = usdc.balanceOf(customer);
        vm.prank(customer);
        usdc.transfer(stranger, have - bal);
        if (allowance < PRICE) {
            assertEq(_reason(subKey), 11);
            vm.expectRevert(abi.encodeWithSelector(RetempoSubscriptionManager.InsufficientAllowance.selector, customer, uint256(PRICE), allowance));
            _charge(subKey);
        } else if (bal < PRICE) {
            assertEq(_reason(subKey), 12);
            vm.expectRevert(abi.encodeWithSelector(RetempoSubscriptionManager.InsufficientBalance.selector, customer, uint256(PRICE), bal));
            _charge(subKey);
        } else {
            assertEq(_reason(subKey), 0);
            _charge(subKey);
            assertEq(usdc.balanceOf(customer), bal - PRICE);
            assertEq(usdc.allowance(customer, address(mgr)), allowance - PRICE);
        }
    }

    // ------------------------------------------------------------ random actors

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_AnyCallerMayChargeButGainsNothing(address caller) public {
        vm.assume(!_excluded(caller));
        (planKey, subKey) = _directSub();
        _mandate(subKey, PRICE, 3 * PRICE, T0 + 100 days);
        vm.warp(T0 + INTERVAL);
        uint256 callerBefore = usdc.balanceOf(caller);
        vm.prank(caller);
        mgr.charge(subKey);
        assertEq(usdc.balanceOf(caller), callerBefore);
        assertEq(usdc.balanceOf(payout), 2 * PRICE);
        assertEq(usdc.balanceOf(customer), CUSTOMER_FUNDS - 2 * PRICE);
        assertEq(_man(subKey).spent, PRICE);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_RandomCallerCannotUseRestrictedFunctions(address caller) public {
        vm.assume(!_excluded(caller));
        (planKey, subKey) = _directSub();
        _mandate(subKey, PRICE, 3 * PRICE, T0 + 100 days);
        vm.warp(T0 + INTERVAL);
        bytes memory unauth = abi.encodeWithSelector(Unauthorized.selector);
        vm.startPrank(caller);
        vm.expectRevert(unauth);
        mgr.renew(subKey);
        vm.expectRevert(unauth);
        mgr.createMandate(subKey, PRICE, PRICE, uint40(block.timestamp + 1 days));
        vm.expectRevert(unauth);
        mgr.revokeMandate(subKey);
        vm.expectRevert(unauth);
        mgr.cancelSubscription(subKey);
        vm.expectRevert(unauth);
        mgr.setPlanActive(planKey, false);
        vm.expectRevert(unauth);
        mgr.setPlanPayout(planKey, caller);
        vm.stopPrank();
        bytes32 pr = mgr.PAUSER_ROLE();
        bytes32 cr = mgr.CONFIG_ROLE();
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, caller, pr));
        mgr.pause();
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, caller, bytes32(0)));
        mgr.unpause();
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, caller, cr));
        mgr.setMaxPaymentAmount(1e9);
        // nothing moved
        assertEq(_sub(subKey).chargeCount, 1);
        assertEq(usdc.balanceOf(payout), PRICE);
        assertTrue(_man(subKey).active);
        assertTrue(mgr.getPlan(planKey).active);
        assertFalse(mgr.paused());
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_RandomSubscriberKeysAreIsolated(address who, bytes32 ref) public {
        vm.assume(!_excluded(who) && ref != bytes32(0));
        planKey = _directPlan();
        usdc.mint(who, PRICE);
        vm.prank(who);
        usdc.approve(address(mgr), PRICE);
        vm.prank(who);
        bytes32 k = mgr.subscribe(ref, planKey, address(0));
        assertEq(k, mgr.subscriptionKey(who, ref));
        assertEq(_sub(k).customer, who);
        assertEq(usdc.balanceOf(who), 0);
        assertEq(usdc.balanceOf(payout), PRICE);
        // a different account cannot pay or cancel on behalf of `who`
        vm.prank(customer);
        vm.expectRevert(Unauthorized.selector);
        mgr.renew(k);
        vm.prank(customer);
        vm.expectRevert(Unauthorized.selector);
        mgr.cancelSubscription(k);
    }
}
