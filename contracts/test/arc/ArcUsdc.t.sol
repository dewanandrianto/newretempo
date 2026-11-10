// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {ArcUsdcBase} from "./ArcUsdcBase.sol";
import {RetempoEscrow} from "../../RetempoEscrow.sol";
import {RetempoSubscriptionManager} from "../../RetempoSubscriptionManager.sol";
import {ZeroAddress} from "../../interfaces/RetempoErrors.sol";

/// @dev Arc-specific tests against the REAL USDC predeploy. Skipped under plain `forge test`.
contract ArcUsdcCoreTest is ArcUsdcBase {
    // ------------------------------------------------------------ (1) sanity

    function test_01_Sanity_RealUsdcSystemDeploys() public {
        _arcOnly();
        assertEq(token.decimals(), 6);
        assertEq(token.symbol(), "USDC");
        assertTrue(token.blacklister() != address(0));
        assertTrue(token.pauser() != address(0));

        // Fresh system: constructed paused, then unpaused by admin.
        (RetempoEscrow e2, RetempoSubscriptionManager m2) = _deploySystem(USDC);
        assertTrue(e2.paused());
        assertTrue(m2.paused());
        vm.startPrank(admin);
        e2.unpause();
        m2.unpause();
        vm.stopPrank();
        assertFalse(e2.paused());
        assertFalse(m2.paused());
        assertEq(address(e2.usdc()), USDC);
        assertEq(address(m2.usdc()), USDC);

        // The setUp system is live as well.
        assertFalse(escrow.paused());
        assertFalse(mgr.paused());
        assertEq(address(escrow.usdc()), USDC);
        _shared(customer, F, "customer");
        _shared(address(mgr), 0, "manager");
        _shared(address(escrow), 0, "escrow");
    }

    // ------------------------------------------------------------ (2) lifecycle

    function _assertPaymentEvent(Vm.Log[] memory logs, uint32 n, uint8 trigger, bytes32 ekey) internal view {
        Vm.Log memory l = _find(logs, address(mgr), RetempoSubscriptionManager.SubscriptionPaymentProcessed.selector);
        (uint32 cn, address m, uint128 amt, uint8 trg, bytes32 rk,,,) =
            abi.decode(l.data, (uint32, address, uint128, uint8, bytes32, uint40, uint40, bool));
        assertEq(cn, n, "chargeNumber");
        assertEq(m, merchant);
        assertEq(amt, PRICE, "manager event amount is 6-dec base units");
        assertEq(trg, trigger, "trigger");
        assertEq(rk, ekey, "routed key");
        Vm.Log memory f = _find(logs, address(escrow), RetempoEscrow.EscrowFunded.selector);
        (uint128 famt,,, bool viaManager) = abi.decode(f.data, (uint128, uint40, uint40, bool));
        assertEq(famt, PRICE, "escrow event amount is 6-dec base units");
        assertTrue(viaManager);
    }

    function test_02_FullLifecycle_SubscribeChargeVestClaimWithdraw() public {
        _arcOnly();
        bytes32 planKey = _escrowPlan();
        vm.recordLogs();
        bytes32 subKey = _subscribe(planKey);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 key1 = _routedKey(merchant, subKey, 1);
        bytes32 key2 = _routedKey(merchant, subKey, 2);

        // subscribe: customer->manager, manager->escrow; each Transfer appears from BOTH emitters.
        {
            Tr[] memory erc = _dualTransfers(logs, 2);
            assertEq(erc[0].from, customer);
            assertEq(erc[0].to, address(mgr));
            assertEq(erc[0].value, PRICE);
            assertEq(erc[1].from, address(mgr));
            assertEq(erc[1].to, address(escrow));
            assertEq(erc[1].value, PRICE);
        }
        _assertPaymentEvent(logs, 1, 0, key1);
        _shared(customer, F - PRICE, "customer");
        _shared(address(mgr), 0, "manager");
        _shared(address(escrow), PRICE, "escrow");
        _shared(merchant, 0, "merchant");
        assertEq(escrow.totalLocked(), PRICE);
        assertEq(token.allowance(address(mgr), address(escrow)), 0, "no residual allowance");

        // recurring charge via mandate
        _stdMandate(subKey);
        vm.warp(T0 + INTERVAL);
        vm.recordLogs();
        _charge(subKey);
        logs = vm.getRecordedLogs();
        {
            Tr[] memory erc = _dualTransfers(logs, 2);
            assertEq(erc[0].from, customer);
            assertEq(erc[1].to, address(escrow));
        }
        _assertPaymentEvent(logs, 2, 1, key2);
        assertEq(_man(subKey).spent, PRICE);
        _shared(customer, F - 2 * uint256(PRICE), "customer");
        _shared(address(mgr), 0, "manager");
        _shared(address(escrow), 2 * uint256(PRICE), "escrow");
        _escrowExact();

        // vesting + claim: key1 fully vested (30d >= 14d); key2 vests over the next VEST.
        vm.prank(merchant);
        escrow.claim(key1);
        assertEq(escrow.withdrawableOf(merchant), PRICE);
        assertEq(escrow.totalLocked(), PRICE);
        _escrowExact();
        vm.warp(T0 + INTERVAL + VEST / 2);
        assertEq(escrow.claimableAmount(key2), PRICE / 2);
        vm.prank(merchant);
        escrow.claim(key2);
        assertEq(escrow.withdrawableOf(merchant), PRICE + PRICE / 2);
        vm.warp(T0 + INTERVAL + VEST);
        vm.prank(merchant);
        escrow.claim(key2);
        assertEq(uint8(escrow.getEscrow(key2).status), 3, "Closed");
        assertEq(escrow.withdrawableOf(merchant), 2 * uint256(PRICE));
        assertEq(escrow.totalLocked(), 0);
        assertEq(escrow.totalWithdrawable(), 2 * uint256(PRICE));
        _escrowExact();
        _shared(merchant, 0, "merchant before withdraw");

        // withdraw
        vm.recordLogs();
        vm.prank(merchant);
        escrow.withdraw(merchant);
        logs = vm.getRecordedLogs();
        Tr[] memory w = _dualTransfers(logs, 1);
        assertEq(w[0].from, address(escrow));
        assertEq(w[0].to, merchant);
        assertEq(w[0].value, 2 * uint256(PRICE));
        Vm.Log memory wl = _find(logs, address(escrow), RetempoEscrow.Withdrawn.selector);
        assertEq(abi.decode(wl.data, (uint256)), 2 * uint256(PRICE), "Withdrawn carries 6-dec units");
        _shared(merchant, 2 * uint256(PRICE), "merchant");
        _shared(address(escrow), 0, "escrow");
        _shared(address(mgr), 0, "manager");
        _shared(customer, F - 2 * uint256(PRICE), "customer");
        assertEq(escrow.totalWithdrawable(), 0);
        assertEq(escrow.withdrawableOf(merchant), 0);
    }

    // ------------------------------------------------------------ (3) blocklisted merchant

    function test_03a_BlocklistedMerchant_WithdrawReverts_OthersSucceed_UnblockRestores() public {
        _arcOnly();
        _twoMerchantCredits();
        _block(merchant);

        vm.prank(merchant);
        vm.expectRevert(_blocked());
        escrow.withdraw(merchant);
        vm.prank(stranger);
        vm.expectRevert(_blocked());
        escrow.withdrawToPayout(merchant);
        assertEq(escrow.withdrawableOf(merchant), PRICE, "credit intact");
        assertEq(escrow.totalWithdrawable(), 2 * uint256(PRICE));
        _escrowExact();

        vm.prank(merchant2);
        escrow.withdraw(merchant2);
        _shared(merchant2, PRICE, "merchant2");
        assertEq(escrow.totalWithdrawable(), PRICE);
        assertEq(escrow.withdrawableOf(merchant), PRICE, "blocked credit still intact");

        _unblock(merchant);
        vm.prank(merchant);
        escrow.withdraw(merchant);
        _shared(merchant, PRICE, "merchant");
        _shared(address(escrow), 0, "escrow");
        assertEq(escrow.totalWithdrawable(), 0);
    }

    function test_03b_BlocklistedMerchant_SetPayoutAddress_ThenWithdrawToPayout() public {
        _arcOnly();
        _twoMerchantCredits();
        _block(merchant);
        vm.prank(merchant);
        vm.expectRevert(_blocked());
        escrow.withdraw(merchant);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.PayoutAddressUpdated(merchant, payout, 0);
        vm.prank(merchant);
        escrow.setPayoutAddress(payout);
        assertEq(escrow.payoutAddress(merchant), payout);

        vm.prank(stranger);
        escrow.withdrawToPayout(merchant);
        _shared(payout, PRICE, "payout");
        _shared(merchant, 0, "blocked merchant holds nothing");
        assertEq(escrow.withdrawableOf(merchant), 0);
        assertEq(escrow.totalWithdrawable(), PRICE, "merchant2 credit untouched");
        _escrowExact();
    }

    function test_03c_BlocklistedMerchant_SetPayoutAddressBySig_RelayedByThirdParty() public {
        _arcOnly();
        (address sigM, uint256 pk) = makeAddrAndKey("sigMerchant");
        (,, bytes32 ekey) = _escrowSubFor(sigM, customer, keccak256("plan-sig"), keccak256("sub-sig"), false);
        vm.warp(T0 + VEST);
        vm.prank(sigM);
        escrow.claim(ekey);
        assertEq(escrow.withdrawableOf(sigM), PRICE);
        _block(sigM);
        vm.prank(sigM);
        vm.expectRevert(_blocked());
        escrow.withdraw(sigM);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _payoutDigest(sigM, payout2, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(stranger); // third-party relayer; the blocked account never transacts
        escrow.setPayoutAddressBySig(sigM, payout2, deadline, sig);
        assertEq(escrow.payoutAddress(sigM), payout2);
        assertEq(escrow.nonces(sigM), 1);

        // replay of the same signature fails (nonce consumed)
        vm.prank(stranger);
        vm.expectRevert(RetempoEscrow.InvalidSignature.selector);
        escrow.setPayoutAddressBySig(sigM, payout2, deadline, sig);

        vm.prank(stranger);
        escrow.withdrawToPayout(sigM);
        _shared(payout2, PRICE, "payout2");
        _shared(sigM, 0, "blocked merchant");
        assertEq(escrow.withdrawableOf(sigM), 0);
        _escrowExact();
    }

    function test_03d_BlocklistedMerchant_CanStillClaim_AndWithdrawToCleanRecipient() public {
        _arcOnly();
        (, bytes32 subKey, bytes32 ekey) = _escrowSubFor(merchant, customer, PREF, SREF, false);
        assertTrue(subKey != bytes32(0));
        _block(merchant);
        vm.warp(T0 + VEST);
        vm.prank(merchant);
        escrow.claim(ekey); // internal accounting only: no token transfer involved
        assertEq(escrow.withdrawableOf(merchant), PRICE);
        vm.prank(merchant);
        vm.expectRevert(_blocked());
        escrow.withdraw(merchant);
        // withdraw(to) with a clean recipient only moves escrow->clean; the blocked account is not a party.
        vm.prank(merchant);
        escrow.withdraw(payout);
        _shared(payout, PRICE, "payout");
        _shared(address(escrow), 0, "escrow");
        assertEq(escrow.totalWithdrawable(), 0);
    }

    // ------------------------------------------------------------ (10) zero address

    function test_10_WithdrawToZeroAddressReverts() public {
        _arcOnly();
        _twoMerchantCredits();
        vm.prank(merchant);
        vm.expectRevert(ZeroAddress.selector);
        escrow.withdraw(address(0));
        assertEq(escrow.withdrawableOf(merchant), PRICE, "credit intact");
        assertEq(escrow.totalWithdrawable(), 2 * uint256(PRICE));
        // also with no credit: zero-address check precedes the empty-credit check
        vm.prank(stranger);
        vm.expectRevert(ZeroAddress.selector);
        escrow.withdraw(address(0));
        _escrowExact();
    }

    // ------------------------------------------------------------ (11) griefing isolation

    function test_11_BlockedRecipientCannotBlockAnotherUser() public {
        _arcOnly();
        _twoMerchantCredits();
        _block(merchant);
        // attacker's repeated failed withdrawals leave no residue
        for (uint256 i; i < 3; i++) {
            vm.prank(merchant);
            vm.expectRevert(_blocked());
            escrow.withdraw(merchant);
        }
        // merchant2 is withdrawable both directly and via a third-party-triggered payout pull
        vm.prank(stranger);
        escrow.withdrawToPayout(merchant2);
        _shared(merchant2, PRICE, "merchant2");
        assertEq(escrow.withdrawableOf(merchant2), 0);
        assertEq(escrow.withdrawableOf(merchant), PRICE, "blocked credit isolated and intact");
        assertEq(escrow.totalWithdrawable(), PRICE);
        _escrowExact();
        // a stranger cannot redirect the blocked user's credit
        vm.prank(stranger);
        escrow.setPayoutAddress(stranger);
        vm.prank(stranger);
        vm.expectRevert(_blocked()); // still pays merchant (payoutAddress[merchant] unset)
        escrow.withdrawToPayout(merchant);
        assertEq(escrow.withdrawableOf(merchant), PRICE);
        _i1();
    }
}
