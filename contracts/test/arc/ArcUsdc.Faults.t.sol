// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ArcUsdcBase, ForceSend} from "./ArcUsdcBase.sol";

/// @dev Arc-specific fault tests (issuer blocklist, pause, native view hazards) on the REAL USDC predeploy.
contract ArcUsdcFaultsTest is ArcUsdcBase {
    bytes32 internal constant SREF2 = keccak256("sub-extra");
    bytes internal constant PAUSED = bytes("Pausable: paused");

    // ------------------------------------------------------------ (4) blocklisted customer

    function test_04a_BlocklistedCustomer_SubscribeRenewCharge_RevertAtomically() public {
        _arcOnly();
        (bytes32 planKey, bytes32 subKey) = _escrowSub();
        _stdMandate(subKey);
        _block(customer);
        vm.warp(T0 + INTERVAL);
        bytes32 h = _stateHash(subKey, customer);

        vm.prank(stranger);
        vm.expectRevert(_blocked());
        mgr.charge(subKey);
        assertEq(_stateHash(subKey, customer), h, "charge atomic");

        vm.prank(customer);
        vm.expectRevert(_blocked());
        mgr.renew(subKey);
        assertEq(_stateHash(subKey, customer), h, "renew atomic");

        bytes32 newSub = mgr.subscriptionKey(customer, SREF2);
        vm.prank(customer);
        vm.expectRevert(_blocked());
        mgr.subscribe(SREF2, planKey, arb);
        assertEq(uint8(_sub(newSub).status), 0, "no subscription created");
        assertEq(_stateHash(subKey, customer), h, "subscribe atomic");

        assertEq(_sub(subKey).chargeCount, 1);
        assertEq(_sub(subKey).nextChargeAt, T0 + INTERVAL);
        assertEq(_man(subKey).spent, 0);
        assertEq(escrow.totalLocked(), PRICE);
        _shared(customer, F - PRICE, "customer");
        _shared(address(escrow), PRICE, "escrow");

        // unblock: the very same charge now succeeds
        _unblock(customer);
        _charge(subKey);
        assertEq(_sub(subKey).chargeCount, 2);
        assertEq(_man(subKey).spent, PRICE);
        _shared(address(escrow), 2 * uint256(PRICE), "escrow");
    }

    function test_04b_BlocklistedCustomer_RefundCredit_WithdrawReverts_UntilRedirected() public {
        _arcOnly();
        (,, bytes32 ekey) = _escrowSubFor(merchant, customer, PREF, SREF, true);
        _block(customer);
        vm.prank(customer);
        escrow.customerRefundUnvested(ekey); // internal accounting only
        assertEq(escrow.withdrawableOf(customer), PRICE, "refund credit created");
        assertEq(escrow.totalLocked(), 0);
        assertEq(escrow.totalWithdrawable(), PRICE);

        vm.prank(customer);
        vm.expectRevert(_blocked());
        escrow.withdraw(customer);
        assertEq(escrow.withdrawableOf(customer), PRICE, "credit intact");
        _escrowExact();

        vm.prank(customer);
        escrow.setPayoutAddress(payout);
        vm.prank(stranger);
        escrow.withdrawToPayout(customer);
        _shared(payout, PRICE, "payout");
        _shared(customer, F - PRICE, "blocked customer unchanged");
        _shared(address(escrow), 0, "escrow");
    }

    function test_04c_BlocklistedCustomer_RefundCredit_UnblockRestoresPlainWithdraw() public {
        _arcOnly();
        (,, bytes32 ekey) = _escrowSubFor(merchant, customer, PREF, SREF, true);
        _block(customer);
        vm.prank(customer);
        escrow.customerRefundUnvested(ekey);
        vm.prank(customer);
        vm.expectRevert(_blocked());
        escrow.withdraw(customer);
        _unblock(customer);
        vm.prank(customer);
        escrow.withdraw(customer);
        _shared(customer, F, "customer fully refunded");
        _shared(address(escrow), 0, "escrow");
        assertEq(escrow.totalWithdrawable(), 0);
    }

    // ------------------------------------------------------------ (5) blocklisted escrow (custodian freeze)

    function test_05_BlocklistedEscrow_WithdrawFrozen_InternalCreditsWork_UnblockExact() public {
        _arcOnly();
        bytes32 keyC;
        (,, keyA) = _escrowSubFor(merchant, customer, PREF, SREF, false);
        (,, keyB) = _escrowSubFor(merchant2, customer2, keccak256("plan-2"), keccak256("sub-2"), true);
        (,, keyC) = _escrowSubFor(merchant2, customer, keccak256("plan-C"), keccak256("sub-C"), false);
        bytes32 subA = mgr.subscriptionKey(customer, SREF);
        assertEq(escrow.totalLocked(), 3 * uint256(PRICE));

        _block(address(escrow));

        // internal credits still work while the escrow is frozen: refund, dispute resolution, claim
        vm.prank(customer2);
        escrow.customerRefundUnvested(keyB);
        vm.prank(customer);
        escrow.openDispute(keyC, PRICE, keccak256("reason"));
        vm.prank(merchant2);
        escrow.respondToDispute(keyC, bytes32(0));
        vm.prank(arb);
        escrow.resolveDispute(keyC, 40e6, bytes32(0));
        vm.warp(T0 + VEST);
        vm.prank(merchant);
        escrow.claim(keyA);

        assertEq(escrow.withdrawableOf(merchant), 100e6);
        assertEq(escrow.withdrawableOf(merchant2), 40e6);
        assertEq(escrow.withdrawableOf(customer), 60e6);
        assertEq(escrow.withdrawableOf(customer2), 100e6);
        assertEq(escrow.totalLocked(), 0);
        assertEq(escrow.totalWithdrawable(), 3 * uint256(PRICE));
        _escrowExact();

        // withdraw reverts for everyone, liabilities unchanged
        address[4] memory who = [merchant, merchant2, customer, customer2];
        uint256[4] memory credit = [uint256(100e6), 40e6, 60e6, 100e6];
        for (uint256 i; i < 4; i++) {
            vm.prank(who[i]);
            vm.expectRevert(_blocked());
            escrow.withdraw(who[i]);
            assertEq(escrow.withdrawableOf(who[i]), credit[i], "credit intact");
        }
        assertEq(escrow.totalWithdrawable(), 3 * uint256(PRICE));
        _escrowExact();

        // new manager payments revert atomically
        vm.warp(T0 + INTERVAL);
        bytes32 h = _stateHash(subA, customer);
        vm.prank(customer);
        vm.expectRevert(_blockedSender());
        mgr.renew(subA);
        assertEq(_stateHash(subA, customer), h, "renew atomic");
        bytes32 planA = mgr.planKey(merchant, PREF);
        vm.prank(customer);
        vm.expectRevert(_blockedSender());
        mgr.subscribe(SREF2, planA, arb);
        assertEq(uint8(_sub(mgr.subscriptionKey(customer, SREF2)).status), 0);
        assertEq(_stateHash(subA, customer), h, "subscribe atomic");
        assertEq(escrow.totalLocked(), 0);

        // custodian lifts the freeze: everything is withdrawable exactly
        _unblock(address(escrow));
        for (uint256 i; i < 4; i++) {
            vm.prank(who[i]);
            escrow.withdraw(who[i]);
        }
        _shared(merchant, 100e6, "merchant");
        _shared(merchant2, 40e6, "merchant2");
        _shared(customer, F - 2 * uint256(PRICE) + 60e6, "customer");
        _shared(customer2, F, "customer2");
        _shared(address(escrow), 0, "escrow");
        assertEq(escrow.totalWithdrawable(), 0);
    }

    // ------------------------------------------------------------ (6) blocklisted manager

    function test_06_BlocklistedManager_PaymentsRevertAtomically() public {
        _arcOnly();
        (bytes32 planKey, bytes32 subKey) = _escrowSub();
        _stdMandate(subKey);
        vm.prank(merchant2);
        bytes32 directPlan = mgr.createPlan(keccak256("plan-direct"), payout, PRICE, INTERVAL, 0, GRACE, 0, address(0), false);
        _block(address(mgr));
        vm.warp(T0 + INTERVAL);
        bytes32 h = _stateHash(subKey, customer);

        vm.prank(stranger);
        vm.expectRevert(_blockedSender());
        mgr.charge(subKey);
        vm.prank(customer);
        vm.expectRevert(_blockedSender());
        mgr.renew(subKey);
        vm.prank(customer);
        vm.expectRevert(_blockedSender());
        mgr.subscribe(SREF2, planKey, arb);
        vm.prank(customer2);
        vm.expectRevert(_blockedSender());
        mgr.subscribe(SREF2, directPlan, address(0)); // direct-plan spender is the manager too
        assertEq(_stateHash(subKey, customer), h, "all atomic");
        assertEq(uint8(_sub(mgr.subscriptionKey(customer, SREF2)).status), 0);
        assertEq(uint8(_sub(mgr.subscriptionKey(customer2, SREF2)).status), 0);
        _shared(payout, 0, "payout untouched");
        _shared(customer2, F, "customer2 untouched");

        _unblock(address(mgr));
        _charge(subKey);
        assertEq(_sub(subKey).chargeCount, 2);
        _shared(address(mgr), 0, "manager holds nothing");
    }

    // ------------------------------------------------------------ (7) direct plan, blocklisted payout

    function test_07_DirectPlan_BlocklistedPayout_AtomicRevert_ThenSetPlanPayoutRecovers() public {
        _arcOnly();
        (bytes32 planKey, bytes32 subKey) = _directSub();
        _shared(payout, PRICE, "payout after first period");
        _stdMandate(subKey);
        _block(payout);
        vm.warp(T0 + INTERVAL);
        bytes32 h = _stateHash(subKey, customer);

        vm.prank(stranger);
        vm.expectRevert(_blocked());
        mgr.charge(subKey);
        assertEq(_stateHash(subKey, customer), h, "charge atomic");
        assertEq(_sub(subKey).chargeCount, 1);
        assertEq(_man(subKey).spent, 0);
        assertEq(_sub(subKey).nextChargeAt, T0 + INTERVAL);

        // new subscription into the blocked payout also fails atomically
        vm.prank(customer2);
        vm.expectRevert(_blocked());
        mgr.subscribe(SREF2, planKey, address(0));
        assertEq(uint8(_sub(mgr.subscriptionKey(customer2, SREF2)).status), 0);

        vm.prank(merchant);
        mgr.setPlanPayout(planKey, payout2);
        _charge(subKey);
        assertEq(_sub(subKey).chargeCount, 2, "billed exactly one period");
        assertEq(_man(subKey).spent, PRICE);
        assertEq(_sub(subKey).nextChargeAt, T0 + 2 * uint256(INTERVAL));
        _shared(payout2, PRICE, "new payout");
        _shared(customer, F - 2 * uint256(PRICE), "customer charged exactly twice in total");
        // not billable twice for one period
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("NotDue()"));
        mgr.charge(subKey);
    }

    // ------------------------------------------------------------ (8) USDC paused by its pauser

    function test_08_UsdcPaused_PaymentsAndWithdrawRevert_CreditsIntact_UnpauseRestores() public {
        _arcOnly();
        (,, keyA) = _escrowSubFor(merchant, customer, PREF, SREF, false);
        (,, keyB) = _escrowSubFor(merchant2, customer2, keccak256("plan-2"), keccak256("sub-2"), false);
        vm.warp(T0 + VEST);
        vm.prank(merchant);
        escrow.claim(keyA);
        _pauseUsdc();

        vm.prank(merchant);
        vm.expectRevert(PAUSED);
        escrow.withdraw(merchant);
        assertEq(escrow.withdrawableOf(merchant), PRICE, "credit intact");

        bytes32 subA = mgr.subscriptionKey(customer, SREF);
        bytes32 h = _stateHash(subA, customer);
        bytes32 planA = mgr.planKey(merchant, PREF);
        vm.prank(customer);
        vm.expectRevert(PAUSED);
        mgr.subscribe(SREF2, planA, arb);
        assertEq(uint8(_sub(mgr.subscriptionKey(customer, SREF2)).status), 0);
        vm.warp(T0 + INTERVAL);
        vm.prank(customer);
        vm.expectRevert(PAUSED);
        mgr.renew(subA);
        assertEq(_stateHash(subA, customer), h, "atomic while USDC paused");

        // internal accounting is unaffected by the token pause
        vm.prank(merchant2);
        escrow.claim(keyB);
        assertEq(escrow.withdrawableOf(merchant2), PRICE);
        assertEq(escrow.totalWithdrawable(), 2 * uint256(PRICE));
        _escrowExact();

        _unpauseUsdc();
        vm.prank(merchant);
        escrow.withdraw(merchant);
        vm.prank(merchant2);
        escrow.withdraw(merchant2);
        _shared(merchant, PRICE, "merchant");
        _shared(merchant2, PRICE, "merchant2");
        vm.prank(customer);
        mgr.renew(subA);
        assertEq(_sub(subA).chargeCount, 2);
        _shared(address(escrow), PRICE, "escrow holds renewed period");
    }

    // ------------------------------------------------------------ (9) native view hazards

    function test_09a_NativeValueToEscrowOrManager_Reverts() public {
        _arcOnly();
        vm.deal(address(this), 10 ether);
        uint256[3] memory amounts = [uint256(1), 1e12, 1 ether];
        for (uint256 i; i < 3; i++) {
            (bool ok,) = address(escrow).call{value: amounts[i]}("");
            assertFalse(ok, "escrow rejects native value");
            (ok,) = address(mgr).call{value: amounts[i]}("");
            assertFalse(ok, "manager rejects native value");
        }
        assertEq(address(escrow).balance, 0);
        assertEq(address(mgr).balance, 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_09b_ForcedNativeFunding_DoesNotTouchLiabilities_DustInvisible() public {
        _arcOnly();
        (,, keyA) = _escrowSubFor(merchant, customer, PREF, SREF, false);
        uint256 base = uint256(PRICE) * SCALE;
        assertEq(address(escrow).balance, base);

        // dust below 1e12 native units: native balance moves, ERC-20 view does not
        new ForceSend{value: 999_999_999_999}(payable(address(escrow)));
        assertEq(address(escrow).balance, base + 999_999_999_999, "native balance includes dust");
        assertEq(token.balanceOf(address(escrow)), PRICE, "dust invisible to balanceOf");
        assertEq(escrow.totalLocked(), PRICE);
        assertEq(escrow.totalWithdrawable(), 0);
        _i1();

        // 3 whole base units (+776 wei) -> total dust 1e12+775... => balanceOf rises by 4
        new ForceSend{value: 3e12 + 777}(payable(address(escrow)));
        assertEq(address(escrow).balance, base + 999_999_999_999 + 3e12 + 777);
        assertEq(token.balanceOf(address(escrow)), uint256(PRICE) + 4, "balanceOf = floor(native / 1e12)");
        assertEq(escrow.totalLocked(), PRICE, "totalLocked unchanged by donation");
        assertEq(escrow.totalWithdrawable(), 0, "totalWithdrawable unchanged by donation");
        _i1();

        // manager donation does not break its balance-delta checks
        new ForceSend{value: 2e12}(payable(address(mgr)));
        _shared(address(mgr), 2, "manager donation");
        _escrowSubFor(merchant2, customer2, keccak256("plan-2"), keccak256("sub-2"), false);
        assertEq(escrow.totalLocked(), 2 * uint256(PRICE));
        assertEq(token.balanceOf(address(mgr)), 2, "manager balance untouched by payment");
        assertEq(token.balanceOf(address(escrow)), 2 * uint256(PRICE) + 4);
        _i1();

        // full cycle: withdrawals are exact; donation stays stuck
        vm.warp(T0 + VEST);
        vm.prank(merchant);
        escrow.claim(keyA);
        vm.prank(merchant);
        escrow.withdraw(merchant);
        _shared(merchant, PRICE, "merchant exact");
        assertEq(escrow.totalWithdrawable(), 0);
        assertEq(escrow.totalLocked(), PRICE);
        assertEq(token.balanceOf(address(escrow)), uint256(PRICE) + 4);
        _i1();
    }
}
