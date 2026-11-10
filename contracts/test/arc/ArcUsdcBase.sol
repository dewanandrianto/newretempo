// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {RetempoSystemBase} from "../helpers/RetempoSystemBase.sol";
import {RetempoEscrow} from "../../RetempoEscrow.sol";
import {RetempoSubscriptionManager} from "../../RetempoSubscriptionManager.sol";

/// @dev Minimal view of the Arc USDC predeploy (FiatToken-style with blacklist + pause).
interface IArcUsdc {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function blacklister() external view returns (address);
    function pauser() external view returns (address);
    function blacklist(address) external;
    function unBlacklist(address) external;
    function isBlacklisted(address) external view returns (bool);
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
}

/// @dev Forces native value into `target` by selfdestructing in its own creation transaction.
contract ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}

/// @dev Arc fixture: real USDC predeploy, no MockUSDC. Contains NO test functions.
abstract contract ArcUsdcBase is RetempoSystemBase {
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant SYS_EMITTER = 0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE;
    uint256 internal constant SCALE = 1e12; // native 18-dec units per ERC-20 6-dec base unit
    uint256 internal constant F = 10_000e6; // initial USDC per customer (6-dec base units)
    bytes32 internal constant TRANSFER_SIG = keccak256("Transfer(address,address,uint256)");

    IArcUsdc internal token;
    bytes32 internal keyA;
    bytes32 internal keyB;

    struct Tr {
        address from;
        address to;
        uint256 value;
    }

    function setUp() public virtual override {
        if (USDC.code.length == 0) return; // plain forge: every test skips itself
        vm.warp(T0);
        token = IArcUsdc(USDC);
        (escrow, mgr) = _deploySystem(USDC);
        _bootstrap(escrow, mgr);
        _fundAcct(customer, F);
        _fundAcct(customer2, F);
        _approveUsdc(customer);
        _approveUsdc(customer2);
    }

    /// @dev First statement of every test: skip unless the Arc USDC predeploy has code.
    function _arcOnly() internal {
        if (USDC.code.length == 0) vm.skip(true);
    }

    // ------------------------------------------------------------ funding / views

    function _fundAcct(address who, uint256 usdcAmount) internal {
        vm.deal(who, usdcAmount * SCALE);
        assertEq(token.balanceOf(who), usdcAmount, "erc20 view after deal");
        assertEq(who.balance, usdcAmount * SCALE, "native view after deal");
    }

    function _approveUsdc(address who) internal {
        vm.prank(who);
        token.approve(address(mgr), type(uint256).max);
    }

    /// @dev Both views of `who` must agree: native == erc20 * 1e12 (no dust).
    function _shared(address who, uint256 expectedUsdc, string memory label) internal view {
        assertEq(token.balanceOf(who), expectedUsdc, string.concat(label, ": erc20"));
        assertEq(who.balance, expectedUsdc * SCALE, string.concat(label, ": native"));
    }

    /// @dev I1: erc20 balance of escrow covers recorded liabilities.
    function _i1() internal view {
        assertGe(token.balanceOf(address(escrow)), escrow.totalLocked() + escrow.totalWithdrawable(), "I1");
    }

    /// @dev Exact conservation when nothing was force-donated.
    function _escrowExact() internal view {
        assertEq(token.balanceOf(address(escrow)), escrow.totalLocked() + escrow.totalWithdrawable(), "escrow exact");
        assertEq(address(escrow).balance, (escrow.totalLocked() + escrow.totalWithdrawable()) * SCALE, "escrow native");
    }

    // ------------------------------------------------------------ issuer roles

    function _block(address who) internal {
        address b = token.blacklister();
        vm.prank(b);
        token.blacklist(who);
        assertTrue(token.isBlacklisted(who), "blacklisted");
    }

    function _unblock(address who) internal {
        address b = token.blacklister();
        vm.prank(b);
        token.unBlacklist(who);
        assertFalse(token.isBlacklisted(who), "unblacklisted");
    }

    function _pauseUsdc() internal {
        address p = token.pauser();
        vm.prank(p);
        token.pause();
        assertTrue(token.paused());
    }

    function _unpauseUsdc() internal {
        address p = token.pauser();
        vm.prank(p);
        token.unpause();
        assertFalse(token.paused());
    }

    /// @dev Revert when the blocklisted account is the FROM/TO party of a transfer (native-layer check on Arc).
    function _blocked() internal pure returns (bytes memory) {
        return bytes("Blocked address");
    }

    /// @dev Revert when the blocklisted account is the token-call msg.sender (FiatToken `notBlacklisted` modifier).
    function _blockedSender() internal pure returns (bytes memory) {
        return bytes("Blacklistable: account is blacklisted");
    }

    // ------------------------------------------------------------ builders

    /// @dev Escrow plan for merchant `m` (vest = VEST, arbitrator = arb) and a first-period subscription by `c`.
    function _escrowSubFor(address m, address c, bytes32 pref, bytes32 sref, bool refundable)
        internal
        returns (bytes32 planKey, bytes32 subKey, bytes32 ekey)
    {
        vm.prank(m);
        planKey = mgr.createPlan(pref, m, PRICE, INTERVAL, 0, GRACE, VEST, arb, refundable);
        vm.prank(c);
        subKey = mgr.subscribe(sref, planKey, arb);
        ekey = _routedKey(m, subKey, 1);
    }

    /// @dev merchant<-customer (A) and merchant2<-customer2 (B), fully vested and claimed: 100e6 credit each.
    function _twoMerchantCredits() internal {
        (,, keyA) = _escrowSubFor(merchant, customer, PREF, SREF, false);
        (,, keyB) = _escrowSubFor(merchant2, customer2, keccak256("plan-2"), keccak256("sub-2"), false);
        vm.warp(T0 + VEST);
        vm.prank(merchant);
        escrow.claim(keyA);
        vm.prank(merchant2);
        escrow.claim(keyB);
        assertEq(escrow.withdrawableOf(merchant), PRICE);
        assertEq(escrow.withdrawableOf(merchant2), PRICE);
        assertEq(escrow.totalWithdrawable(), 2 * uint256(PRICE));
        assertEq(escrow.totalLocked(), 0);
    }

    /// @dev Hash of all user-visible state touched by a payment attempt (for atomicity assertions).
    function _stateHash(bytes32 subKey, address cust) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                _sub(subKey),
                _man(subKey),
                token.balanceOf(cust),
                token.balanceOf(address(escrow)),
                token.balanceOf(address(mgr)),
                escrow.totalLocked(),
                escrow.totalWithdrawable(),
                cust.balance,
                address(escrow).balance,
                address(mgr).balance
            )
        );
    }

    // ------------------------------------------------------------ log helpers

    function _transfers(Vm.Log[] memory logs, address emitter) internal pure returns (Tr[] memory out) {
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics.length == 3 && logs[i].topics[0] == TRANSFER_SIG) n++;
        }
        out = new Tr[](n);
        uint256 j;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics.length == 3 && logs[i].topics[0] == TRANSFER_SIG) {
                out[j++] = Tr(
                    address(uint160(uint256(logs[i].topics[1]))),
                    address(uint160(uint256(logs[i].topics[2]))),
                    abi.decode(logs[i].data, (uint256))
                );
            }
        }
    }

    /// @dev Asserts `n` Transfers from BOTH emitters, pairwise same parties, system value == erc20 value * 1e12.
    function _dualTransfers(Vm.Log[] memory logs, uint256 n) internal pure returns (Tr[] memory erc) {
        erc = _transfers(logs, USDC);
        Tr[] memory sys = _transfers(logs, SYS_EMITTER);
        assertEq(erc.length, n, "erc20 emitter Transfer count");
        assertEq(sys.length, n, "system emitter Transfer count");
        for (uint256 i; i < n; i++) {
            assertEq(sys[i].from, erc[i].from, "from");
            assertEq(sys[i].to, erc[i].to, "to");
            assertEq(sys[i].value, erc[i].value * SCALE, "18-dec value == 6-dec * 1e12");
        }
    }

    function _find(Vm.Log[] memory logs, address emitter, bytes32 sig) internal pure returns (Vm.Log memory l) {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == sig) return logs[i];
        }
        revert("event not found");
    }

    function _payoutDigest(address account, address newPayout, uint256 deadline) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(escrow.SET_PAYOUT_ADDRESS_TYPEHASH(), account, newPayout, escrow.nonces(account), deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", escrow.DOMAIN_SEPARATOR(), structHash));
    }
}
