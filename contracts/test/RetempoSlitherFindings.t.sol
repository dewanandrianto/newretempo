// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RetempoEscrow} from "../RetempoEscrow.sol";
import {RetempoSubscriptionManager} from "../RetempoSubscriptionManager.sol";
import {Unauthorized, DepositMismatch} from "../interfaces/RetempoErrors.sol";
import {RetempoSystemBase} from "./helpers/RetempoSystemBase.sol";
import {BalanceMutatingToken} from "./mocks/BalanceMutatingToken.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";

/// @dev Evidence for Slither High finding `arbitrary-send-erc20` in RetempoSubscriptionManager:
///      `_executePayment` (safeTransferFrom(s.customer, p.payout, s.amount)) and
///      `_fundEscrow` (safeTransferFrom(s.customer, address(this), amount)).
///      The `from` is always the subscription's own customer, so a third party cannot move a victim's funds
///      even when the victim granted the manager a max allowance.
contract RetempoArbitrarySendEvidenceTest is RetempoSystemBase {
    address internal victim = makeAddr("victim");
    uint256 internal constant VICTIM_FUNDS = 5_000e6;
    bytes32 internal constant PREF_E = keccak256("plan-escrow");

    function setUp() public override {
        super.setUp();
        usdc.mint(victim, VICTIM_FUNDS);
        vm.prank(victim);
        usdc.approve(address(mgr), type(uint256).max); // the dangerous precondition: unlimited allowance
    }

    // ---------------------------------------------------------------- helpers

    function _planOf(bool escrowPlan) internal returns (bytes32) {
        return escrowPlan ? _plan(PREF_E, PRICE, INTERVAL, 0, GRACE, VEST) : _plan(PREF, PRICE, INTERVAL, 0, GRACE, 0);
    }

    /// @dev Victim legitimately subscribes (pays period 1) and is warped to the next due time.
    function _victimLive(bool escrowPlan) internal returns (bytes32 sk) {
        sk = _subscribeAs(victim, SREF, _planOf(escrowPlan));
        vm.warp(T0 + INTERVAL);
    }

    function _victimMandate(bytes32 sk, uint128 per, uint128 total, uint256 expiry) internal {
        vm.prank(victim);
        mgr.createMandate(sk, per, total, uint40(expiry));
    }

    /// @dev Stranger charge/renew both revert (charge with `err`), and nothing moves.
    function _assertStrangerBlocked(bytes32 sk, bytes memory err) internal {
        uint256 vb = usdc.balanceOf(victim);
        uint256 pb = usdc.balanceOf(payout);
        uint256 eb = usdc.balanceOf(address(escrow));
        vm.expectRevert(err);
        _charge(sk);
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        mgr.renew(sk);
        assertEq(usdc.balanceOf(victim), vb, "victim balance unchanged");
        assertEq(usdc.balanceOf(payout), pb, "payout unchanged");
        assertEq(usdc.balanceOf(address(escrow)), eb, "escrow unchanged");
        assertEq(usdc.balanceOf(stranger), 0, "stranger gained nothing");
        assertEq(usdc.balanceOf(address(mgr)), 0);
    }

    // ---------------------------------------------------------------- victim never subscribed

    function test_Victim_ApprovedButNeverSubscribed_StrangerCannotChargeOrRenew() public {
        _planOf(false);
        _planOf(true);
        bytes32[4] memory refs = [SREF, PREF, keccak256("x"), bytes32(uint256(1))];
        for (uint256 i; i < refs.length; ++i) {
            bytes32 key = mgr.subscriptionKey(victim, refs[i]);
            _assertStrangerBlocked(key, abi.encodeWithSelector(RetempoSubscriptionManager.SubscriptionInactive.selector));
        }
        assertEq(usdc.balanceOf(victim), VICTIM_FUNDS);
        assertEq(escrow.totalLocked(), 0);
    }

    function test_Victim_ZeroAddressCallerCannotRenewMissingKey() public {
        // customer==address(0) for a missing subscription would pass the customer check for caller 0x0,
        // but the payment still reverts because the subscription is not Active.
        bytes32 key = mgr.subscriptionKey(victim, SREF);
        vm.prank(address(0));
        vm.expectRevert(RetempoSubscriptionManager.SubscriptionInactive.selector);
        mgr.renew(key);
        assertEq(usdc.balanceOf(victim), VICTIM_FUNDS);
    }

    function test_Victim_StrangerSubscribeAlwaysBindsMsgSender() public {
        bool[2] memory kinds = [false, true];
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            bytes32 planKey = _planOf(kinds[i]);
            usdc.mint(stranger, 10 * PRICE);
            vm.prank(stranger);
            usdc.approve(address(mgr), type(uint256).max);
            bytes32 victimKey = mgr.subscriptionKey(victim, SREF);
            bytes32 strangerKey = _subscribeAs(stranger, SREF, planKey); // same external ref as the victim would use
            assertTrue(strangerKey != victimKey, "keys differ");
            assertEq(strangerKey, mgr.subscriptionKey(stranger, SREF));
            assertEq(_sub(strangerKey).customer, stranger, "bound to msg.sender");
            assertEq(uint8(_sub(victimKey).status), 0, "victim has no subscription");
            assertEq(usdc.balanceOf(stranger), 9 * PRICE, "stranger paid with its own funds");
            assertEq(usdc.balanceOf(victim), VICTIM_FUNDS, "victim untouched");
            // the stranger's mandate + charge also only ever touch the stranger
            vm.prank(stranger);
            mgr.createMandate(strangerKey, PRICE, 5 * PRICE, uint40(block.timestamp + 90 days));
            vm.warp(T0 + INTERVAL);
            _charge(strangerKey);
            assertEq(usdc.balanceOf(stranger), 8 * PRICE);
            assertEq(usdc.balanceOf(victim), VICTIM_FUNDS);
            // and cannot administer the victim's (non-existent) key
            vm.prank(stranger);
            vm.expectRevert(Unauthorized.selector);
            mgr.createMandate(victimKey, PRICE, 5 * PRICE, uint40(block.timestamp + 90 days));
            vm.prank(stranger);
            vm.expectRevert(RetempoSubscriptionManager.SubscriptionInactive.selector);
            mgr.cancelSubscription(victimKey);
            vm.revertToState(snap);
        }
    }

    // ---------------------------------------------------------------- victim subscribed, charge gates

    function test_Victim_SubscribedWithoutMandate_StrangerChargeRevertsMandateMissing() public {
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            bytes32 sk = _victimLive(i == 1);
            _assertStrangerBlocked(sk, abi.encodeWithSelector(RetempoSubscriptionManager.MandateMissing.selector));
            assertEq(_sub(sk).chargeCount, 1);
            vm.revertToState(snap);
        }
    }

    function test_Victim_MandateRevoked_StrangerChargeReverts() public {
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            bytes32 sk = _victimLive(i == 1);
            _victimMandate(sk, PRICE, 5 * PRICE, block.timestamp + 90 days);
            vm.prank(victim);
            mgr.revokeMandate(sk);
            _assertStrangerBlocked(sk, abi.encodeWithSelector(RetempoSubscriptionManager.MandateInactive.selector));
            vm.revertToState(snap);
        }
    }

    function test_Victim_MandateExpired_StrangerChargeReverts() public {
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            bytes32 sk = _victimLive(i == 1);
            _victimMandate(sk, PRICE, 5 * PRICE, block.timestamp + 1 hours);
            vm.warp(block.timestamp + 1 hours); // expiry is exclusive
            _assertStrangerBlocked(sk, abi.encodeWithSelector(RetempoSubscriptionManager.MandateExpired.selector));
            vm.revertToState(snap);
        }
    }

    function test_Victim_SubscriptionCancelled_StrangerChargeReverts() public {
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            bytes32 sk = _victimLive(i == 1);
            _victimMandate(sk, PRICE, 5 * PRICE, block.timestamp + 90 days);
            vm.prank(victim);
            mgr.cancelSubscription(sk);
            _assertStrangerBlocked(sk, abi.encodeWithSelector(RetempoSubscriptionManager.SubscriptionInactive.selector));
            vm.revertToState(snap);
        }
    }

    function test_Victim_TotalCapExhausted_StrangerChargeReverts() public {
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            bytes32 sk = _victimLive(i == 1);
            _victimMandate(sk, PRICE, PRICE, block.timestamp + 200 days);
            _charge(sk); // legitimate recurring charge consumes the entire cap
            vm.warp(T0 + 2 * INTERVAL);
            _assertStrangerBlocked(sk, abi.encodeWithSelector(RetempoSubscriptionManager.TotalCapExceeded.selector));
            assertEq(_man(sk).spent, PRICE);
            vm.revertToState(snap);
        }
    }

    function test_Victim_PerChargeCapBelowPrice_CannotBeAuthorizedSoNoChargePath() public {
        bytes32 sk = _victimLive(false);
        vm.prank(victim);
        vm.expectRevert(RetempoSubscriptionManager.InvalidMandateCaps.selector);
        mgr.createMandate(sk, PRICE - 1, 5 * PRICE, uint40(block.timestamp + 90 days));
        _assertStrangerBlocked(sk, abi.encodeWithSelector(RetempoSubscriptionManager.MandateMissing.selector));
    }

    function test_Victim_NotDueYet_StrangerChargeReverts() public {
        bytes32 sk = _subscribeAs(victim, SREF, _planOf(true));
        _victimMandate(sk, PRICE, 5 * PRICE, block.timestamp + 90 days);
        _assertStrangerBlocked(sk, abi.encodeWithSelector(RetempoSubscriptionManager.NotDue.selector));
    }

    // ---------------------------------------------------------------- amount and recipient are fixed

    function test_Charge_AmountIsPriceSnapshotAndRecipientIsPayoutOrEscrow() public {
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            bytes32 sk = _victimLive(i == 1);
            _victimMandate(sk, 40 * PRICE, 400 * PRICE, block.timestamp + 90 days); // generous caps
            uint256 vb = usdc.balanceOf(victim);
            uint256 pb = usdc.balanceOf(payout);
            uint256 eb = usdc.balanceOf(address(escrow));
            _charge(sk);
            assertEq(vb - usdc.balanceOf(victim), PRICE, "debit == price snapshot, not the cap");
            assertEq(_man(sk).spent, PRICE);
            if (i == 1) {
                assertEq(usdc.balanceOf(address(escrow)), eb + PRICE, "escrow is the recipient");
                assertEq(usdc.balanceOf(payout), pb);
            } else {
                assertEq(usdc.balanceOf(payout), pb + PRICE, "payout is the recipient");
                assertEq(usdc.balanceOf(address(escrow)), eb);
            }
            assertEq(usdc.balanceOf(stranger), 0, "caller never receives funds");
            assertEq(usdc.balanceOf(address(mgr)), 0);
            assertEq(usdc.allowance(address(mgr), address(escrow)), 0, "no residual allowance");
            vm.revertToState(snap);
        }
    }

    function test_PriceCannotBeRaisedByMerchant_PlanExistsAndLimitOnlyLowers() public {
        bytes32 sk = _victimLive(false);
        _victimMandate(sk, 40 * PRICE, 400 * PRICE, block.timestamp + 90 days);
        vm.prank(merchant);
        vm.expectRevert(RetempoSubscriptionManager.PlanExists.selector);
        mgr.createPlan(PREF, payout, PRICE * 10, INTERVAL, 0, GRACE, 0, address(0), false);
        assertEq(_sub(sk).amount, PRICE, "snapshot is immutable");
        _setLimit(PRICE - 1); // config can only block, never raise, charges
        uint256 vb = usdc.balanceOf(victim);
        vm.expectRevert(abi.encodeWithSelector(RetempoSubscriptionManager.PaymentLimitExceeded.selector, uint256(PRICE), uint256(PRICE - 1)));
        _charge(sk);
        assertEq(usdc.balanceOf(victim), vb);
    }

    function test_SetPlanPayout_OnlyMerchant() public {
        bytes32 planKey = _planOf(false);
        address[6] memory bad = [stranger, victim, customer, merchant2, payout, arb];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bad[i]);
            vm.expectRevert(Unauthorized.selector);
            mgr.setPlanPayout(planKey, stranger);
        }
        assertEq(mgr.getPlan(planKey).payout, payout, "payout unchanged");
        vm.prank(merchant);
        mgr.setPlanPayout(planKey, payout2);
        assertEq(mgr.getPlan(planKey).payout, payout2);
        // a stranger-chosen payout can never receive a customer charge; the merchant-chosen one does
        bytes32 sk = _subscribeAs(victim, SREF, planKey);
        assertEq(usdc.balanceOf(payout2), PRICE);
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(_sub(sk).customer, victim);
    }

    function test_Renew_NonCustomerReverts() public {
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            bytes32 sk = _victimLive(i == 1);
            address[5] memory bad = [stranger, merchant, payout, customer2, arb];
            uint256 vb = usdc.balanceOf(victim);
            for (uint256 j; j < bad.length; ++j) {
                vm.prank(bad[j]);
                vm.expectRevert(Unauthorized.selector);
                mgr.renew(sk);
            }
            assertEq(usdc.balanceOf(victim), vb);
            assertEq(_sub(sk).chargeCount, 1);
            vm.revertToState(snap);
        }
    }

    // ---------------------------------------------------------------- fuzz

    /// @dev Random caller + random victim state: a victim that never subscribed never loses a unit.
    function testFuzz_NonSubscribedVictimNeverLosesFunds(
        address caller,
        bytes32 ref,
        uint96 funds,
        uint256 allowance,
        uint32 warpBy,
        bool maxAllowance
    ) public {
        vm.assume(caller != victim && caller != address(0));
        assumeNotForgeAddress(caller);
        assumeNotPrecompile(caller);
        // random victim wealth + allowance (the earlier setUp balance is topped up, never reduced)
        usdc.mint(victim, bound(uint256(funds), 0, 1e12));
        vm.prank(victim);
        usdc.approve(address(mgr), maxAllowance ? type(uint256).max : allowance);
        // live third-party subscriptions give the attacker real keys to aim at
        bytes32 escrowSub = _subscribeAs(customer, SREF, _planOf(true));
        bytes32 directSub = _subscribeAs(customer2, SREF, _plan(keccak256("p3"), PRICE, INTERVAL, 0, GRACE, 0));
        _mandate(escrowSub, PRICE, 3 * PRICE, T0 + 300 days);
        vm.warp(T0 + bound(uint256(warpBy), 0, 200 days));

        uint256 vb = usdc.balanceOf(victim);
        bytes32 victimKey = mgr.subscriptionKey(victim, ref);
        bytes32 victimKey2 = mgr.subscriptionKey(victim, SREF);
        bytes32 planE = mgr.planKey(merchant, PREF_E);
        vm.startPrank(caller);
        try mgr.charge(victimKey) {} catch {}
        try mgr.charge(victimKey2) {} catch {}
        try mgr.renew(victimKey) {} catch {}
        try mgr.renew(victimKey2) {} catch {}
        try mgr.charge(escrowSub) {} catch {}
        try mgr.charge(directSub) {} catch {}
        try mgr.renew(escrowSub) {} catch {}
        try mgr.subscribe(ref, planE, arb) {} catch {}
        try mgr.subscribe(SREF, planE, arb) {} catch {}
        try mgr.createMandate(victimKey, PRICE, PRICE, uint40(block.timestamp + 1 days)) {} catch {}
        try mgr.cancelSubscription(victimKey2) {} catch {}
        try mgr.setPlanPayout(mgr.planKey(merchant, PREF), caller) {} catch {}
        vm.stopPrank();

        assertEq(usdc.balanceOf(victim), vb, "victim never debited");
        assertEq(uint8(_sub(victimKey).status), 0, "no subscription ever bound to victim");
        assertEq(uint8(_sub(victimKey2).status), 0);
        assertEq(usdc.balanceOf(address(mgr)), 0);
    }

    /// @dev Random caller on a live, due subscription: debit is exactly PRICE (<= perChargeCap) to payout/escrow.
    function testFuzz_Charge_DebitIsPriceAndRecipientIsNeverCaller(address caller, bool escrowPlan, uint128 perCap, uint32 late) public {
        vm.assume(caller != address(0) && caller != victim && caller != address(escrow) && caller != address(mgr));
        vm.assume(caller != payout && caller != merchant && caller != address(usdc));
        assumeNotForgeAddress(caller);
        assumeNotPrecompile(caller);
        perCap = uint128(bound(perCap, PRICE, 1e12));
        bytes32 sk = _subscribeAs(victim, SREF, _planOf(escrowPlan));
        _victimMandate(sk, perCap, perCap * 3, block.timestamp + 90 days);
        vm.warp(T0 + INTERVAL + bound(uint256(late), 0, GRACE)); // inside grace
        uint256 vb = usdc.balanceOf(victim);
        uint256 cb = usdc.balanceOf(caller);
        uint256 pb = usdc.balanceOf(payout);
        uint256 eb = usdc.balanceOf(address(escrow));
        vm.prank(caller);
        mgr.charge(sk);
        assertEq(vb - usdc.balanceOf(victim), PRICE, "debit == price");
        assertLe(PRICE, perCap);
        assertEq(usdc.balanceOf(caller), cb, "caller not paid");
        assertEq(usdc.balanceOf(payout) - pb + usdc.balanceOf(address(escrow)) - eb, PRICE, "exactly one recipient credited");
        if (escrowPlan) assertEq(usdc.balanceOf(address(escrow)), eb + PRICE);
        else assertEq(usdc.balanceOf(payout), pb + PRICE);
        assertEq(usdc.balanceOf(address(mgr)), 0);
        assertEq(usdc.allowance(address(mgr), address(escrow)), 0);
    }
}

/// @dev Evidence for Slither High finding `reentrancy-balance` in `_fundEscrow`: the manager reads its own token
///      balance before the pull and compares it after the escrow call. A balance change mid-payment must revert the
///      whole payment atomically; a donation made in an EARLIER transaction must not break payments.
contract RetempoBalanceMutationEvidenceTest is RetempoSystemBase {
    BalanceMutatingToken internal tok;
    bytes32 internal planNow;
    bytes32 internal planTrial;
    bytes32 internal skNow; // key the "subscribe" entry will create
    bytes32 internal skTrial; // pre-existing trial subscription (charge / renew entries)

    uint256 internal constant M = 7e6; // unexpected mint
    uint8 internal constant E_SUBSCRIBE = 0;
    uint8 internal constant E_CHARGE = 1;
    uint8 internal constant E_RENEW = 2;

    struct S {
        uint40 next;
        uint32 count;
        uint128 spent;
        uint256 cust;
        uint256 mgrBal;
        uint256 escBal;
        uint256 locked;
        uint256 supply;
        uint8 subStatus;
        uint8 nextEscrowStatus;
    }

    function setUp() public override {
        vm.warp(T0);
        tok = new BalanceMutatingToken();
        _wire(address(tok));
        tok.mint(customer, CUSTOMER_FUNDS);
        vm.prank(customer);
        tok.approve(address(mgr), type(uint256).max);
        planNow = _plan(PREF, PRICE, INTERVAL, 0, GRACE, VEST);
        planTrial = _plan(keccak256("plan-trial"), PRICE, INTERVAL, 1 days, GRACE, VEST);
        skNow = mgr.subscriptionKey(customer, SREF);
        skTrial = _subscribeAs(customer, keccak256("sub-trial"), planTrial);
        _mandate(skTrial, PRICE, 10 * PRICE, T0 + 300 days);
        vm.warp(T0 + 1 days);
    }

    // ---------------------------------------------------------------- helpers

    function _key(uint8 entry) internal view returns (bytes32) {
        return entry == E_SUBSCRIBE ? skNow : skTrial;
    }

    function _call(uint8 entry) internal {
        if (entry == E_SUBSCRIBE) {
            vm.prank(customer);
            mgr.subscribe(SREF, planNow, arb);
        } else if (entry == E_CHARGE) {
            vm.prank(stranger);
            mgr.charge(skTrial);
        } else {
            vm.prank(customer);
            mgr.renew(skTrial);
        }
    }

    function _s(uint8 entry) internal view returns (S memory s) {
        bytes32 sk = _key(entry);
        RetempoSubscriptionManager.Subscription memory sub = mgr.getSubscription(sk);
        s.next = sub.nextChargeAt;
        s.count = sub.chargeCount;
        s.spent = mgr.getMandate(sk).spent;
        s.cust = tok.balanceOf(customer);
        s.mgrBal = tok.balanceOf(address(mgr));
        s.escBal = tok.balanceOf(address(escrow));
        s.locked = escrow.totalLocked();
        s.supply = tok.totalSupply();
        s.subStatus = uint8(sub.status);
        s.nextEscrowStatus = uint8(escrow.getEscrow(_rk(sk, sub.chargeCount + 1)).status);
    }

    function _rk(bytes32 sk, uint32 n) internal view returns (bytes32) {
        return keccak256(abi.encode(merchant, keccak256(abi.encode(sk, n))));
    }

    function _assertSame(S memory a, S memory b) internal pure {
        assertEq(b.next, a.next, "nextChargeAt");
        assertEq(b.count, a.count, "chargeCount");
        assertEq(b.spent, a.spent, "spent");
        assertEq(b.cust, a.cust, "customer balance");
        assertEq(b.mgrBal, a.mgrBal, "manager balance");
        assertEq(b.escBal, a.escBal, "escrow balance");
        assertEq(b.locked, a.locked, "totalLocked");
        assertEq(b.supply, a.supply, "unexpected mint rolled back");
        assertEq(b.subStatus, a.subStatus, "subscription record");
        assertEq(b.nextEscrowStatus, a.nextEscrowStatus, "no escrow record");
    }

    /// @dev Exactly one period billed, one escrow, manager balance unchanged, allowance to escrow zero.
    function _assertOneBilled(uint8 entry, S memory b) internal view {
        S memory a = _s(entry);
        assertEq(a.count, b.count + 1, "one period");
        assertEq(a.cust, b.cust - PRICE, "customer debited once");
        assertEq(a.locked, b.locked + PRICE, "locked + once");
        assertEq(a.escBal, b.escBal + PRICE, "escrow tokens + once");
        assertEq(a.mgrBal, b.mgrBal, "manager balance unchanged by payment");
        assertEq(tok.allowance(address(mgr), address(escrow)), 0, "allowance zero after success");
        bytes32 sk = _key(entry);
        assertEq(uint8(escrow.getEscrow(_rk(sk, b.count + 1)).status), uint8(RetempoEscrow.Status.Active));
    }

    /// @dev Armed side effect -> whole call reverts with `err`, state identical; disarmed retry bills exactly once.
    function _atomicFailThenRetry(uint8 entry, bytes memory err) internal {
        S memory b = _s(entry);
        vm.expectRevert(err);
        _call(entry);
        _assertSame(b, _s(entry));
        tok.disarm();
        _call(entry);
        _assertOneBilled(entry, b);
    }

    function _mintErr(uint256 base) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(DepositMismatch.selector, uint256(PRICE), base, base + PRICE + M);
    }

    // ---------------------------------------------------------------- mint to manager around the customer pull

    function _forEachEntry(bool before_, uint256 nth, address victim_, bytes memory err) internal {
        for (uint8 e; e < 3; ++e) {
            uint256 snap = vm.snapshotState();
            tok.armMint(BalanceMutatingToken.Hook.TransferFrom, victim_, M, before_, nth);
            _atomicFailThenRetry(e, err);
            vm.revertToState(snap);
        }
    }

    function test_MintToManager_BeforeCustomerPull_RevertsAtomically() public {
        _forEachEntry(true, 1, address(mgr), _mintErr(0));
    }

    function test_MintToManager_AfterCustomerPull_RevertsAtomically() public {
        _forEachEntry(false, 1, address(mgr), _mintErr(0));
    }

    function test_MintToManager_BeforeEscrowPull_ManagerBalanceChanged() public {
        _forEachEntry(true, 2, address(mgr), abi.encodeWithSelector(RetempoSubscriptionManager.ManagerBalanceChanged.selector));
    }

    function test_MintToManager_AfterEscrowPull_ManagerBalanceChanged() public {
        _forEachEntry(false, 2, address(mgr), abi.encodeWithSelector(RetempoSubscriptionManager.ManagerBalanceChanged.selector));
    }

    function test_MintToEscrow_DuringEscrowPull_EscrowDepositMismatchBubbles() public {
        _forEachEntry(true, 2, address(escrow), _mintErr(0));
        _forEachEntry(false, 2, address(escrow), _mintErr(0));
    }

    function test_MidPaymentMintToCustomerOrPayout_DoesNotAffectManagerChecks() public {
        address[2] memory others = [customer, payout];
        for (uint256 i; i < 2; ++i) {
            for (uint8 e; e < 3; ++e) {
                uint256 snap = vm.snapshotState();
                S memory b = _s(e);
                tok.armMint(BalanceMutatingToken.Hook.TransferFrom, others[i], M, true, 1);
                _call(e);
                assertTrue(tok.mutated(), "unexpected mint fired");
                S memory a = _s(e);
                assertEq(a.count, b.count + 1);
                assertEq(a.locked, b.locked + PRICE);
                assertEq(a.mgrBal, 0);
                assertEq(tok.allowance(address(mgr), address(escrow)), 0);
                vm.revertToState(snap);
            }
        }
    }

    // ---------------------------------------------------------------- donations in an earlier transaction

    function test_EarlierDonationToManager_DoesNotBreakPayments() public {
        uint256 donation = 333;
        tok.mint(address(mgr), donation); // separate, earlier tx
        for (uint8 e; e < 3; ++e) {
            uint256 snap = vm.snapshotState();
            S memory b = _s(e);
            _call(e);
            _assertOneBilled(e, b);
            assertEq(tok.balanceOf(address(mgr)), donation, "donation neither consumed nor swept");
            vm.revertToState(snap);
        }
    }

    function test_EarlierDonationToEscrow_DoesNotBreakPaymentsOrLiabilities() public {
        tok.mint(address(escrow), 555);
        for (uint8 e; e < 3; ++e) {
            uint256 snap = vm.snapshotState();
            S memory b = _s(e);
            _call(e);
            _assertOneBilled(e, b);
            assertEq(escrow.totalLocked(), b.locked + PRICE, "donation is not a liability");
            assertEq(tok.balanceOf(address(escrow)), 555 + b.locked + PRICE);
            vm.revertToState(snap);
        }
    }

    function test_DonationBetweenPeriods_StillOnePeriodPerPayment() public {
        _call(E_SUBSCRIBE); // period 1 of the new subscription
        tok.mint(address(mgr), 1);
        S memory b = _s(E_RENEW);
        _call(E_RENEW); // period 1 of the trial subscription, with a 1-unit donation already present
        _assertOneBilled(E_RENEW, b);
        tok.mint(address(mgr), 99);
        vm.warp(block.timestamp + INTERVAL);
        b = _s(E_CHARGE);
        _call(E_CHARGE); // period 2 of the trial subscription
        _assertOneBilled(E_CHARGE, b);
        assertEq(tok.balanceOf(address(mgr)), 100, "all donations retained");
        assertEq(escrow.totalLocked(), 3 * PRICE);
    }

    function test_BaselineIsReadInsideTheCall_MidPaymentMintOnTopOfDonationStillReverts() public {
        tok.mint(address(mgr), 333);
        _forEachEntry(true, 1, address(mgr), abi.encodeWithSelector(DepositMismatch.selector, uint256(PRICE), uint256(333), 333 + PRICE + M));
        _forEachEntry(true, 2, address(mgr), abi.encodeWithSelector(RetempoSubscriptionManager.ManagerBalanceChanged.selector));
    }

    // ---------------------------------------------------------------- direct plans do no balance read

    function test_DirectPlan_MidPaymentMintToManagerDoesNotInterfere() public {
        bytes32 directPlan = _plan(keccak256("plan-direct"), PRICE, INTERVAL, 0, GRACE, 0);
        tok.armMint(BalanceMutatingToken.Hook.TransferFrom, address(mgr), M, true, 1);
        _subscribeAs(customer, keccak256("sub-direct"), directPlan);
        assertEq(tok.balanceOf(payout), PRICE);
        assertEq(tok.balanceOf(address(mgr)), M, "stray mint stays in the manager (no sweep exists)");
        assertEq(escrow.totalLocked(), 0);
        assertEq(tok.allowance(address(mgr), address(escrow)), 0);
    }

    // ---------------------------------------------------------------- hostile callbacks (revert bubbles)

    function _callbackPayloads() internal view returns (bytes[3] memory p) {
        p[0] = abi.encodeCall(mgr.subscribe, (keccak256("other"), planNow, arb));
        p[1] = abi.encodeCall(mgr.renew, (skTrial));
        p[2] = abi.encodeCall(mgr.charge, (skTrial));
    }

    function test_CallbackIntoManagerDuringCustomerPull_RevertsWholePayment() public {
        bytes[3] memory p = _callbackPayloads();
        bytes memory rg = abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        for (uint256 i; i < 3; ++i) {
            for (uint256 k; k < 2; ++k) {
                for (uint8 e; e < 3; ++e) {
                    uint256 snap = vm.snapshotState();
                    tok.armCall(BalanceMutatingToken.Hook.TransferFrom, address(mgr), p[i], k == 0, 1);
                    _atomicFailThenRetry(e, rg);
                    vm.revertToState(snap);
                }
            }
        }
    }

    function test_CallbackIntoManagerDuringEscrowPull_RevertsWholePayment() public {
        bytes[3] memory p = _callbackPayloads();
        bytes memory rg = abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        for (uint256 i; i < 3; ++i) {
            for (uint256 k; k < 2; ++k) {
                for (uint8 e; e < 3; ++e) {
                    uint256 snap = vm.snapshotState();
                    tok.armCall(BalanceMutatingToken.Hook.TransferFrom, address(mgr), p[i], k == 0, 2);
                    _atomicFailThenRetry(e, rg);
                    vm.revertToState(snap);
                }
            }
        }
    }

    function test_CallbackIntoEscrowGuardedFunctionsDuringEscrowPull_RevertsWholePayment() public {
        bytes[2] memory p = [
            abi.encodeCall(escrow.withdraw, (customer)),
            abi.encodeCall(escrow.fundFromManager, (keccak256("z"), merchant, customer, PRICE, VEST, arb, false))
        ];
        bytes memory rg = abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        for (uint256 i; i < 2; ++i) {
            for (uint8 e; e < 3; ++e) {
                uint256 snap = vm.snapshotState();
                tok.armCall(BalanceMutatingToken.Hook.TransferFrom, address(escrow), p[i], true, 2);
                _atomicFailThenRetry(e, rg);
                vm.revertToState(snap);
            }
        }
    }

    function test_CallbackIntoUnguardedManagerFunctions_AreCallerGatedAndBubble() public {
        bytes[2] memory p = [abi.encodeCall(mgr.cancelSubscription, (skTrial)), abi.encodeCall(mgr.revokeMandate, (skTrial))];
        for (uint256 i; i < 2; ++i) {
            for (uint8 e; e < 3; ++e) {
                uint256 snap = vm.snapshotState();
                tok.armCall(BalanceMutatingToken.Hook.TransferFrom, address(mgr), p[i], true, 1);
                _atomicFailThenRetry(e, abi.encodeWithSelector(Unauthorized.selector));
                vm.revertToState(snap);
            }
        }
    }
}

/// @dev Same finding, using the swallowing ReentrantToken: the nested call fails with the reentrancy guard
///      (so it cannot change the manager balance) and the outer payment completes with clean accounting.
contract RetempoReentrantTokenEvidenceTest is RetempoSystemBase {
    ReentrantToken internal tok;
    bytes32 internal planNow;
    bytes32 internal skNow;
    bytes32 internal skTrial;

    function setUp() public override {
        vm.warp(T0);
        tok = new ReentrantToken();
        _wire(address(tok));
        tok.mint(customer, CUSTOMER_FUNDS);
        vm.prank(customer);
        tok.approve(address(mgr), type(uint256).max);
        planNow = _plan(PREF, PRICE, INTERVAL, 0, GRACE, VEST);
        bytes32 planTrial = _plan(keccak256("plan-trial"), PRICE, INTERVAL, 1 days, GRACE, VEST);
        skNow = mgr.subscriptionKey(customer, SREF);
        skTrial = _subscribeAs(customer, keccak256("sub-trial"), planTrial);
        _mandate(skTrial, PRICE, 10 * PRICE, T0 + 300 days);
        vm.warp(T0 + 1 days);
    }

    function _payloads() internal view returns (bytes[3] memory p) {
        p[0] = abi.encodeCall(mgr.subscribe, (keccak256("other"), planNow, arb));
        p[1] = abi.encodeCall(mgr.renew, (skTrial));
        p[2] = abi.encodeCall(mgr.charge, (skTrial));
    }

    function _run(uint8 entry, bytes memory payload, bool before_) internal {
        tok.arm(ReentrantToken.Hook.TransferFrom, address(mgr), payload, before_);
        uint256 lockedBefore = escrow.totalLocked();
        bytes32 sk = entry == 0 ? skNow : skTrial;
        if (entry == 0) {
            vm.prank(customer);
            mgr.subscribe(SREF, planNow, arb);
        } else if (entry == 1) {
            vm.prank(stranger);
            mgr.charge(skTrial);
        } else {
            vm.prank(customer);
            mgr.renew(skTrial);
        }
        assertTrue(tok.attacked(), "hook fired");
        assertFalse(tok.attackSucceeded(), "nested call must fail");
        assertEq(bytes4(tok.attackReturn()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "guard reason");
        assertEq(_sub(sk).chargeCount, 1, "exactly one period");
        assertEq(escrow.totalLocked(), lockedBefore + PRICE, "exactly one deposit");
        assertEq(tok.balanceOf(address(mgr)), 0, "manager balance baseline");
        assertEq(tok.allowance(address(mgr), address(escrow)), 0, "allowance zero after success");
        assertEq(uint8(escrow.getEscrow(keccak256(abi.encode(merchant, keccak256(abi.encode(sk, uint32(1)))))).status), uint8(RetempoEscrow.Status.Active));
    }

    function test_NestedCallDuringPull_FailsWithGuardAndPaymentIsClean() public {
        bytes[3] memory p = _payloads();
        for (uint256 i; i < 3; ++i) {
            for (uint256 k; k < 2; ++k) {
                for (uint8 e; e < 3; ++e) {
                    uint256 snap = vm.snapshotState();
                    _run(e, p[i], k == 0);
                    vm.revertToState(snap);
                }
            }
        }
    }
}
