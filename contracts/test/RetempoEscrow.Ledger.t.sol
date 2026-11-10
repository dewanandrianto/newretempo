// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RetempoBase} from "./helpers/RetempoBase.sol";
import {RetempoEscrow} from "../RetempoEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Wallet1271} from "./mocks/Wallet1271.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";
import {ZeroAddress, Unauthorized} from "../interfaces/RetempoErrors.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Unit tests: pull ledger, payout address (direct + EIP-712/1271), blocklist, pause matrix,
///         unauthorized matrix, reentrancy, native value.
contract RetempoEscrowLedgerTest is RetempoBase {
    bytes32 internal key;

    function setUp() public override {
        super.setUp();
        key = _std();
    }

    function _digest(address account, address newPayout, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        bytes32 typehash = keccak256("SetPayoutAddress(address account,address newPayout,uint256 nonce,uint256 deadline)");
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("RetempoEscrow"),
                keccak256("1"),
                block.chainid,
                address(escrow)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(typehash, account, newPayout, nonce, deadline))));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ───────────────────────── withdraw ─────────────────────────

    function test_EIP712_DomainAndTypehashMatchSpec() public view {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("RetempoEscrow"),
                keccak256("1"),
                block.chainid,
                address(escrow)
            )
        );
        assertEq(escrow.DOMAIN_SEPARATOR(), domain);
        assertEq(escrow.SET_PAYOUT_ADDRESS_TYPEHASH(), keccak256("SetPayoutAddress(address account,address newPayout,uint256 nonce,uint256 deadline)"));
    }

    function test_Withdraw_SendsFullCreditToChosenRecipient() public {
        skip(DURATION);
        _claim(key);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.Withdrawn(merchant, payout, AMOUNT);
        vm.prank(merchant);
        escrow.withdraw(payout);
        assertEq(usdc.balanceOf(payout), AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.withdrawableOf(merchant), 0);
        assertEq(escrow.totalWithdrawable(), 0);
        vm.prank(merchant);
        vm.expectRevert(RetempoEscrow.NothingToWithdraw.selector);
        escrow.withdraw(payout);
    }

    function test_Withdraw_Reverts() public {
        vm.prank(stranger);
        vm.expectRevert(RetempoEscrow.NothingToWithdraw.selector);
        escrow.withdraw(stranger);
        skip(DURATION);
        _claim(key);
        vm.prank(merchant);
        vm.expectRevert(ZeroAddress.selector);
        escrow.withdraw(address(0));
        assertEq(escrow.withdrawableOf(merchant), AMOUNT);
        // a caller can only drain its own ledger
        vm.prank(stranger);
        vm.expectRevert(RetempoEscrow.NothingToWithdraw.selector);
        escrow.withdraw(merchant);
    }

    function test_WithdrawToPayout_DefaultsToAccountAndIsPermissionless() public {
        skip(DURATION);
        _claim(key);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.Withdrawn(merchant, merchant, AMOUNT);
        vm.prank(stranger);
        escrow.withdrawToPayout(merchant);
        assertEq(usdc.balanceOf(merchant), AMOUNT);
        vm.prank(stranger);
        vm.expectRevert(RetempoEscrow.NothingToWithdraw.selector);
        escrow.withdrawToPayout(merchant);
    }

    // ───────────────────────── payout address ─────────────────────────

    function test_SetPayoutAddress_DirectRedirectsAndResets() public {
        skip(DURATION);
        _claim(key);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.PayoutAddressUpdated(merchant, payout, 0);
        vm.prank(merchant);
        escrow.setPayoutAddress(payout);
        assertEq(escrow.payoutAddress(merchant), payout);
        assertEq(escrow.nonces(merchant), 1);
        vm.prank(stranger);
        escrow.withdrawToPayout(merchant);
        assertEq(usdc.balanceOf(payout), AMOUNT);
        assertEq(usdc.balanceOf(merchant), 0);
        // zero resets to self
        vm.prank(merchant);
        escrow.setPayoutAddress(address(0));
        assertEq(escrow.payoutAddress(merchant), address(0));
        // another account cannot change merchant's payout via the direct setter
        vm.prank(stranger);
        escrow.setPayoutAddress(stranger);
        assertEq(escrow.payoutAddress(merchant), address(0));
    }

    function test_SetPayoutBySig_EOA() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(MERCHANT_PK, _digest(merchant, payout, 0, deadline));
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.PayoutAddressUpdated(merchant, payout, 0);
        vm.prank(stranger); // relayer
        escrow.setPayoutAddressBySig(merchant, payout, deadline, sig);
        assertEq(escrow.payoutAddress(merchant), payout);
        assertEq(escrow.nonces(merchant), 1);
    }

    function test_SetPayoutBySig_RedirectsWithdrawal() public {
        skip(DURATION);
        _claim(key);
        uint256 deadline = block.timestamp;
        bytes memory sig = _sign(MERCHANT_PK, _digest(merchant, payout, 0, deadline));
        escrow.setPayoutAddressBySig(merchant, payout, deadline, sig);
        escrow.withdrawToPayout(merchant);
        assertEq(usdc.balanceOf(payout), AMOUNT);
    }

    function test_SetPayoutBySig_WrongSignerReverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(CUSTOMER_PK, _digest(merchant, payout, 0, deadline));
        vm.expectRevert(RetempoEscrow.InvalidSignature.selector);
        escrow.setPayoutAddressBySig(merchant, payout, deadline, sig);
        // garbage signature
        vm.expectRevert(RetempoEscrow.InvalidSignature.selector);
        escrow.setPayoutAddressBySig(merchant, payout, deadline, hex"1234");
        // signature over different payout than submitted
        bytes memory good = _sign(MERCHANT_PK, _digest(merchant, payout, 0, deadline));
        vm.expectRevert(RetempoEscrow.InvalidSignature.selector);
        escrow.setPayoutAddressBySig(merchant, stranger, deadline, good);
        assertEq(escrow.nonces(merchant), 0);
    }

    function test_SetPayoutBySig_ExpiredDeadlineReverts() public {
        // Cheatcode timestamps must be read explicitly under IR instrumentation.
        uint256 deadline = vm.getBlockTimestamp();
        bytes memory sig = _sign(MERCHANT_PK, _digest(merchant, payout, 0, deadline));
        vm.warp(deadline + 1);
        assertGt(vm.getBlockTimestamp(), deadline, "signature deadline must be past");
        vm.expectRevert(RetempoEscrow.SignatureExpired.selector);
        escrow.setPayoutAddressBySig(merchant, payout, deadline, sig);
    }

    function test_SetPayoutBySig_ReplayedNonceReverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(MERCHANT_PK, _digest(merchant, payout, 0, deadline));
        escrow.setPayoutAddressBySig(merchant, payout, deadline, sig);
        vm.expectRevert(RetempoEscrow.InvalidSignature.selector);
        escrow.setPayoutAddressBySig(merchant, payout, deadline, sig);
    }

    function test_SetPayoutBySig_DirectUpdateInvalidatesOutstandingSignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(MERCHANT_PK, _digest(merchant, payout, 0, deadline));
        vm.prank(merchant);
        escrow.setPayoutAddress(address(0)); // consumes nonce 0
        vm.expectRevert(RetempoEscrow.InvalidSignature.selector);
        escrow.setPayoutAddressBySig(merchant, payout, deadline, sig);
    }

    function test_SetPayoutBySig_ZeroAccountReverts() public {
        vm.expectRevert(ZeroAddress.selector);
        escrow.setPayoutAddressBySig(address(0), payout, block.timestamp, hex"");
    }

    function test_SetPayoutBySig_ERC1271Wallet() public {
        Wallet1271 wallet = new Wallet1271(vm.addr(CUSTOMER_PK));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory bad = _sign(MERCHANT_PK, _digest(address(wallet), payout, 0, deadline));
        vm.expectRevert(RetempoEscrow.InvalidSignature.selector);
        escrow.setPayoutAddressBySig(address(wallet), payout, deadline, bad);
        bytes memory good = _sign(CUSTOMER_PK, _digest(address(wallet), payout, 0, deadline));
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RetempoEscrow.PayoutAddressUpdated(address(wallet), payout, 0);
        escrow.setPayoutAddressBySig(address(wallet), payout, deadline, good);
        assertEq(escrow.payoutAddress(address(wallet)), payout);
        vm.expectRevert(RetempoEscrow.InvalidSignature.selector); // replay
        escrow.setPayoutAddressBySig(address(wallet), payout, deadline, good);
    }

    // ───────────────────────── blocklist (Arc USDC behaviour) ─────────────────────────

    function test_Blocklist_OnlyBlockedUsersWithdrawRevertsCreditSurvives() public {
        vm.warp(T0 + 15 days);
        _claim(key); // merchant 45
        vm.prank(merchant);
        escrow.merchantRefund(key, 20e6); // customer 20
        usdc.setBlocked(merchant, true);
        uint256 total = escrow.totalWithdrawable();

        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocked.selector, merchant));
        escrow.withdraw(merchant);
        assertEq(escrow.withdrawableOf(merchant), 45e6, "credit survives");
        assertEq(escrow.totalWithdrawable(), total);

        // other users unaffected
        uint256 custBal = usdc.balanceOf(customer);
        vm.prank(customer);
        escrow.withdraw(customer);
        assertEq(usdc.balanceOf(customer) - custBal, 20e6);
        assertEq(escrow.withdrawableOf(customer), 0);

        // blocked account can still redirect to a clean address
        vm.prank(merchant);
        escrow.withdraw(payout);
        assertEq(usdc.balanceOf(payout), 45e6);
        assertEq(escrow.withdrawableOf(merchant), 0);
    }

    function test_Blocklist_BlockedPayoutOnlyFailsThatWithdrawToPayout() public {
        skip(DURATION);
        _claim(key);
        vm.prank(merchant);
        escrow.setPayoutAddress(payout);
        usdc.setBlocked(payout, true);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocked.selector, payout));
        escrow.withdrawToPayout(merchant);
        assertEq(escrow.withdrawableOf(merchant), AMOUNT);
        vm.prank(merchant);
        escrow.setPayoutAddress(address(0)); // account can recover by resetting
        escrow.withdrawToPayout(merchant);
        assertEq(usdc.balanceOf(merchant), AMOUNT);
    }

    // ───────────────────────── pause matrix ─────────────────────────

    function test_Pause_BlocksCreationAndFundingOnly() public {
        bytes32 pending = _create(keccak256("pending"), AMOUNT, DURATION, false);
        bytes32 h = escrow.termsHash(pending);
        vm.prank(pauser);
        escrow.pause();
        vm.prank(merchant);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.createEscrow(keccak256("new"), customer, AMOUNT, DURATION, arb, false);
        vm.prank(customer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.fund(pending, arb, h);
        vm.prank(manager);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.fundFromManager(keccak256("m"), merchant, customer, AMOUNT, DURATION, arb, false);
    }

    function test_Pause_AllLifecycleAndExitsStillWork() public {
        bytes32 kRef = _createAndFund(keccak256("refundable"), AMOUNT, DURATION, true);
        bytes32 kDisp = _createAndFund(keccak256("dispute"), AMOUNT, DURATION, false);
        bytes32 kExp = _createAndFund(keccak256("expire"), AMOUNT, DURATION, false);
        bytes32 kSet = _createAndFund(keccak256("settle"), AMOUNT, DURATION, false);
        _dispute(kExp, 10e6);
        skip(10 days);
        vm.prank(pauser);
        escrow.pause();

        // claim + both refunds
        vm.prank(merchant);
        escrow.claim(key);
        vm.prank(merchant);
        escrow.merchantRefund(kRef, 10e6);
        vm.prank(customer);
        escrow.customerRefundUnvested(kRef);
        // dispute lifecycle
        vm.prank(customer);
        escrow.openDispute(kDisp, 10e6, HASH);
        vm.prank(merchant);
        escrow.respondToDispute(kDisp, HASH);
        vm.prank(arb);
        escrow.resolveDispute(kDisp, 5e6, HASH);
        // replacement then expiry
        vm.prank(merchant);
        escrow.proposeArbitratorReplacement(kExp, arb2);
        vm.prank(customer);
        escrow.acceptArbitratorReplacement(kExp, arb2);
        skip(30 days);
        vm.prank(stranger);
        escrow.expireDispute(kExp);
        // settlement
        vm.prank(merchant);
        escrow.proposeSettlement(kSet, 20e6);
        vm.prank(customer);
        escrow.acceptSettlement(kSet, 20e6, 1);
        // ledger exits
        vm.prank(merchant);
        escrow.setPayoutAddress(payout);
        vm.prank(stranger);
        escrow.withdrawToPayout(merchant);
        vm.prank(customer);
        escrow.withdraw(customer);
        assertGt(usdc.balanceOf(payout), 0);
        assertGt(usdc.balanceOf(customer), 0);
        assertTrue(escrow.paused());
    }

    // ───────────────────────── unauthorized-caller matrix ─────────────────────────

    function test_UnauthorizedMatrix_StrangerCannotCallAnyRestrictedFunction() public {
        _dispute(key, 10e6);
        bytes4 unauth = Unauthorized.selector;
        bytes4 acl = IAccessControl.AccessControlUnauthorizedAccount.selector;
        bytes[19] memory data = [
            abi.encodeCall(escrow.cancelUnfunded, (key)),
            abi.encodeCall(escrow.fund, (key, arb, bytes32(0))),
            abi.encodeCall(escrow.fundFromManager, (REF, merchant, customer, AMOUNT, DURATION, arb, false)),
            abi.encodeCall(escrow.claim, (key)),
            abi.encodeCall(escrow.merchantRefund, (key, 1)),
            abi.encodeCall(escrow.customerRefundUnvested, (key)),
            abi.encodeCall(escrow.openDispute, (key, 1, HASH)),
            abi.encodeCall(escrow.respondToDispute, (key, HASH)),
            abi.encodeCall(escrow.resolveDispute, (key, 0, HASH)),
            abi.encodeCall(escrow.proposeSettlement, (key, 0)),
            abi.encodeCall(escrow.acceptSettlement, (key, 0, 1)),
            abi.encodeCall(escrow.proposeArbitratorReplacement, (key, arb2)),
            abi.encodeCall(escrow.acceptArbitratorReplacement, (key, arb2)),
            abi.encodeCall(escrow.pause, ()),
            abi.encodeCall(escrow.unpause, ()),
            abi.encodeCall(escrow.setMinAmount, (1)),
            abi.encodeCall(escrow.addArbitrator, (stranger)),
            abi.encodeCall(escrow.removeArbitrator, (arb)),
            abi.encodeCall(escrow.setMaxEscrowAmount, (1e9))
        ];
        for (uint256 i; i < data.length; ++i) {
            vm.prank(stranger);
            (bool ok, bytes memory ret) = address(escrow).call(data[i]);
            assertFalse(ok, "call must revert");
            bytes4 expected = i >= 13 ? acl : unauth;
            assertEq(bytes4(ret), expected, "wrong revert selector");
        }
        bytes[3] memory more = [
            abi.encodeCall(escrow.setMaxAggregateExposure, (1)),
            abi.encodeCall(escrow.setResponseWindow, (2 days)),
            abi.encodeCall(escrow.setResolutionTimeout, (40 days))
        ];
        for (uint256 i; i < more.length; ++i) {
            vm.prank(stranger);
            (bool ok, bytes memory ret) = address(escrow).call(more[i]);
            assertFalse(ok);
            assertEq(bytes4(ret), acl);
        }
        // bad-signature payout change
        bytes memory badSig = _sign(CUSTOMER_PK, bytes32(uint256(1)));
        vm.prank(stranger);
        vm.expectRevert(RetempoEscrow.InvalidSignature.selector);
        escrow.setPayoutAddressBySig(merchant, stranger, block.timestamp, badSig);
    }

    function test_UnauthorizedMatrix_RolesAreSeparated() public {
        // admin cannot pause / config / manage arbitrators; pauser cannot unpause
        bytes[4] memory data = [
            abi.encodeCall(escrow.pause, ()),
            abi.encodeCall(escrow.setMinAmount, (1)),
            abi.encodeCall(escrow.addArbitrator, (stranger)),
            abi.encodeCall(escrow.unpause, ())
        ];
        address[4] memory callers = [admin, admin, configMgr, pauser];
        for (uint256 i; i < 4; ++i) {
            vm.prank(callers[i]);
            (bool ok, bytes memory ret) = address(escrow).call(data[i]);
            assertFalse(ok);
            assertEq(bytes4(ret), IAccessControl.AccessControlUnauthorizedAccount.selector);
        }
    }

    // ───────────────────────── reentrancy ─────────────────────────

    function _reentrantSetup() internal returns (ReentrantToken rt, RetempoEscrow e2) {
        rt = new ReentrantToken();
        e2 = _deploy(address(rt));
        _bootstrap(e2);
        rt.mint(customer, 1_000e6);
        rt.mint(manager, 1_000e6);
        vm.prank(customer);
        rt.approve(address(e2), type(uint256).max);
        vm.prank(manager);
        rt.approve(address(e2), type(uint256).max);
    }

    function _assertBlocked(ReentrantToken rt) internal view {
        assertTrue(rt.attacked(), "hook did not fire");
        assertFalse(rt.attackSucceeded(), "reentrant call succeeded");
        assertEq(bytes4(rt.attackReturn()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    function test_Reentrancy_OnFundIsBlocked() public {
        (ReentrantToken rt, RetempoEscrow e2) = _reentrantSetup();
        for (uint256 i; i < 5; ++i) {
            bool before_ = i % 2 == 0;
            bytes32 ref = keccak256(abi.encode("r", i));
            vm.prank(merchant);
            bytes32 k = e2.createEscrow(ref, customer, AMOUNT, DURATION, arb, false);
            bytes32 h = e2.termsHash(k);
            bytes memory payload;
            if (i == 0) payload = abi.encodeCall(e2.fund, (k, arb, h));
            else if (i == 1) payload = abi.encodeCall(e2.withdraw, (address(rt)));
            else if (i == 2) payload = abi.encodeCall(e2.withdrawToPayout, (merchant));
            else if (i == 3) payload = abi.encodeCall(e2.fundFromManager, (keccak256("x"), merchant, customer, AMOUNT, DURATION, arb, false));
            else payload = abi.encodeCall(e2.setPayoutAddressBySig, (merchant, payout, block.timestamp, hex""));
            rt.arm(ReentrantToken.Hook.TransferFrom, address(e2), payload, before_);
            vm.prank(customer);
            e2.fund(k, arb, h);
            _assertBlocked(rt);
            assertEq(uint8(e2.getEscrow(k).status), uint8(RetempoEscrow.Status.Active));
        }
        assertEq(e2.totalLocked(), 5 * uint256(AMOUNT));
        assertEq(rt.balanceOf(address(e2)), 5 * uint256(AMOUNT));
    }

    function test_Reentrancy_OnWithdrawIsBlockedAndPaidOnce() public {
        (ReentrantToken rt, RetempoEscrow e2) = _reentrantSetup();
        for (uint256 i; i < 3; ++i) {
            bytes32 k;
            {
                vm.prank(merchant);
                k = e2.createEscrow(keccak256(abi.encode("w", i)), customer, AMOUNT, DURATION, arb, false);
                bytes32 h = e2.termsHash(k);
                vm.prank(customer);
                e2.fund(k, arb, h);
            }
            skip(DURATION);
            vm.prank(merchant);
            e2.claim(k);
            bytes memory payload = i == 0
                ? abi.encodeCall(e2.withdraw, (address(rt)))
                : i == 1 ? abi.encodeCall(e2.withdrawToPayout, (merchant)) : abi.encodeCall(e2.fund, (k, arb, bytes32(0)));
            rt.arm(ReentrantToken.Hook.Transfer, address(e2), payload, i == 2);
            uint256 bal0 = rt.balanceOf(merchant);
            vm.prank(merchant);
            e2.withdraw(merchant);
            _assertBlocked(rt);
            assertEq(rt.balanceOf(merchant) - bal0, AMOUNT, "paid exactly once");
            assertEq(e2.withdrawableOf(merchant), 0);
            assertEq(e2.totalWithdrawable(), 0);
        }
        assertEq(rt.balanceOf(address(e2)), 0);
    }

    // ───────────────────────── native value ─────────────────────────

    function test_NativeValue_Rejected() public {
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(escrow).call{value: 1 ether}("");
        assertFalse(ok, "plain transfer must revert");
        (ok,) = address(escrow).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok, "unknown selector with value must revert");
        (ok,) = address(escrow).call{value: 1 wei}(abi.encodeCall(escrow.claim, (key)));
        assertFalse(ok, "nonpayable function with value must revert");
        (ok,) = address(escrow).call{value: 1 wei}(abi.encodeCall(escrow.withdraw, (merchant)));
        assertFalse(ok);
        assertEq(address(escrow).balance, 0);
    }
}
