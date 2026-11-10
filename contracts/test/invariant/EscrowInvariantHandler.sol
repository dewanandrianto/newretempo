// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, Vm} from "forge-std/Test.sol";
import {RetempoEscrow} from "../../RetempoEscrow.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Stateful handler. Bounded actors/amounts, ghost variables, and per-call snapshot checks.
///      Party actions, role-holder actions (admin/config/pauser/arbitrator-manager), and time all
///      run through here; every external call is wrapped in try/catch so sequences keep going.
contract EscrowInvariantHandler is Test {
    struct Snap {
        uint256 bal;
        uint256 locked;
        uint256 wd;
        uint256[] w;
        uint256[] b;
    }

    RetempoEscrow public immutable escrow;
    MockUSDC public immutable usdc;
    address public immutable admin;
    address public immutable pauser;
    address public immutable configMgr;
    address public immutable arbMgr;
    address public immutable manager;

    address[] public merchants;
    address[] public customers;
    address[] public arbs;
    address[] public payouts;
    address[] public accounts; // merchants + customers (the only possible credit owners)
    bytes32[] public keys;

    uint256 public ghostIn; // USDC that entered the escrow (deposits + donations)
    uint256 public ghostWithdrawn; // sum of Withdrawn event amounts
    uint256 public nonce;
    bool public ledgerViolation; // a credit/B decreased or USDC left outside withdraw
    bool public roleViolation; // a role-holder action moved credit, B, or USDC
    bool public rulingViolation; // a ruling exceeded frozen or mis-split
    bool public misuseSucceeded; // a wrong-role call succeeded
    uint256[40] public ok;
    address internal exempt;
    address internal immutable owner; // the invariant test contract (only it may reset the counters)

    /// @dev Which kind of escrow an action wants to act on (state-aware key selection).
    enum K {
        Any,
        Pending,
        Active,
        Claimable,
        Free,
        Refundable,
        Disputable,
        Respondable,
        Resolvable,
        Expirable,
        Proposed,
        Replacing
    }

    // Transient-fault bookkeeping: faults injected by config/pause/role actions are always
    // repaired within a few handler calls so the system stays usable.
    uint256 internal pausedLeft; // calls until the handler auto-unpauses
    uint256 internal conflictLeft; // calls until a granted conflicting role is revoked
    address internal conflictAcct;
    bytes32 internal conflictRole;
    uint256 internal removedLeft; // calls until a removed arbitrator is re-added
    address internal removedArb;

    modifier tracked(bool isRole) {
        _tick();
        Snap memory s = _snap();
        exempt = address(0);
        _;
        _verify(s, isRole);
    }

    constructor(
        RetempoEscrow e,
        MockUSDC u,
        address admin_,
        address pauser_,
        address configMgr_,
        address arbMgr_,
        address manager_,
        address arbA,
        address arbB
    ) {
        owner = msg.sender;
        escrow = e;
        usdc = u;
        admin = admin_;
        pauser = pauser_;
        configMgr = configMgr_;
        arbMgr = arbMgr_;
        manager = manager_;
        address arbC = makeAddr("arbC");
        vm.prank(arbMgr_);
        e.addArbitrator(arbC);
        arbs.push(arbA);
        arbs.push(arbB);
        arbs.push(arbC);
        for (uint256 i; i < 3; ++i) {
            address m = makeAddr(string.concat("hm", vm.toString(i)));
            address c = makeAddr(string.concat("hc", vm.toString(i)));
            merchants.push(m);
            customers.push(c);
            payouts.push(makeAddr(string.concat("hp", vm.toString(i))));
            accounts.push(m);
            accounts.push(c);
            vm.prank(c);
            u.approve(address(e), type(uint256).max);
        }
    }

    // ───────────────────────── views for the invariant contract ─────────────────────────

    function keysLength() external view returns (uint256) {
        return keys.length;
    }

    function accountsLength() external view returns (uint256) {
        return accounts.length;
    }

    // ───────────────────────── internals ─────────────────────────

    function _snap() internal view returns (Snap memory s) {
        s.bal = usdc.balanceOf(address(escrow));
        s.locked = escrow.totalLocked();
        s.wd = escrow.totalWithdrawable();
        s.w = new uint256[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) s.w[i] = escrow.withdrawableOf(accounts[i]);
        s.b = new uint256[](keys.length);
        for (uint256 i; i < keys.length; ++i) s.b[i] = escrow.balanceOf(keys[i]);
    }

    function _verify(Snap memory s, bool isRole) internal {
        for (uint256 i; i < s.w.length; ++i) {
            if (accounts[i] != exempt && escrow.withdrawableOf(accounts[i]) < s.w[i]) ledgerViolation = true;
        }
        for (uint256 i; i < s.b.length; ++i) {
            if (s.b[i] == 0) continue; // unfunded (or closed) at snapshot: funding may legitimately raise B
            uint256 b = escrow.balanceOf(keys[i]);
            if (b > s.b[i]) ledgerViolation = true;
            if (isRole && b != s.b[i]) roleViolation = true;
        }
        uint256 bal = usdc.balanceOf(address(escrow));
        if (isRole) {
            if (bal != s.bal || escrow.totalLocked() != s.locked || escrow.totalWithdrawable() != s.wd) roleViolation = true;
        } else if (exempt == address(0) && bal < s.bal) {
            ledgerViolation = true;
        }
        exempt = address(0);
    }

    /// @dev Repairs injected faults a few calls after they were injected (pause, conflicting role,
    ///      removed arbitrator) so the exploration cannot get permanently stuck.
    function _tick() internal {
        if (pausedLeft > 0) {
            if (!escrow.paused()) {
                pausedLeft = 0;
            } else if (--pausedLeft == 0) {
                vm.prank(admin);
                try escrow.unpause() {} catch {}
            }
        }
        if (conflictLeft > 0 && --conflictLeft == 0) {
            vm.prank(admin);
            try escrow.revokeRole(conflictRole, conflictAcct) {} catch {}
        }
        if (removedLeft > 0 && --removedLeft == 0) {
            vm.prank(arbMgr);
            try escrow.addArbitrator(removedArb) {} catch {
                removedLeft = 1; // still conflicted: retry next call
            }
        }
    }

    /// @dev Picks the first key (scanning cyclically from `seed % n`) in the wanted state. Falls back to
    ///      `seed % n` when none matches, and ~1/8 of the time picks blindly to keep negative paths covered.
    function _pickKey(uint256 seed, K kind) internal view returns (bytes32) {
        uint256 n = keys.length;
        uint256 start = seed % n;
        if (kind == K.Any || (seed >> 200) % 8 == 7) return keys[start];
        for (uint256 j; j < n; ++j) {
            bytes32 k = keys[(start + j) % n];
            if (_match(k, kind)) return k;
        }
        return keys[start];
    }

    function _match(bytes32 k, K kind) internal view returns (bool) {
        RetempoEscrow.Escrow memory e = escrow.getEscrow(k);
        if (kind == K.Pending) return e.status == RetempoEscrow.Status.Pending;
        if (e.status != RetempoEscrow.Status.Active) return false;
        if (kind == K.Active) return true;
        if (kind == K.Claimable) return escrow.claimableAmount(k) > 0;
        if (kind == K.Free) return escrow.freeBalanceOf(k) > 0;
        if (kind == K.Refundable) {
            return e.customerMayRefundUnvested && escrow.freeBalanceOf(k) > escrow.claimableAmount(k);
        }
        if (kind == K.Disputable) return e.dispute == RetempoEscrow.DisputeState.None;
        if (kind == K.Proposed) return e.settlementProposer != address(0);
        if (kind == K.Replacing) return e.replacementProposer != address(0);
        if (e.dispute != RetempoEscrow.DisputeState.Open) return false;
        uint256 respEnd = uint256(e.disputedAt) + e.responseWindow;
        if (kind == K.Respondable) return !e.merchantResponded && block.timestamp <= respEnd;
        if (kind == K.Resolvable) return block.timestamp < uint256(e.disputedAt) + e.resolutionTimeout
            && (e.merchantResponded || block.timestamp > respEnd);
        return block.timestamp >= uint256(e.disputedAt) + e.resolutionTimeout; // Expirable
    }

    /// @dev Picks an account that currently has withdrawable credit (fallback: `seed % n`).
    function _pickAccount(uint256 seed) internal view returns (address) {
        uint256 n = accounts.length;
        uint256 start = seed % n;
        for (uint256 j; j < n; ++j) {
            address a = accounts[(start + j) % n];
            if (escrow.withdrawableOf(a) > 0) return a;
        }
        return accounts[start];
    }

    /// @dev Deposit amount that respects the live min/max (so config drift cannot starve creation);
    ///      ~1/16 of the time it ignores them to keep the out-of-bounds revert path covered.
    function _amt(uint256 s) internal view returns (uint128) {
        if ((s >> 200) % 16 == 15) return uint128(bound(s, 10_000, 500e6));
        uint256 lo = escrow.minAmount();
        if (lo < 10_000) lo = 10_000;
        uint256 hi = escrow.maxEscrowAmount();
        uint256 cap = s % 2 == 0 ? 500e6 : 50e6; // half the deposits are small to preserve exposure headroom
        if (hi > cap) hi = cap;
        if (hi < lo) hi = lo;
        return uint128(bound(s, lo, hi));
    }

    /// @notice Zeroes the per-action counters (called once by the test after seeding in setUp so the
    ///         coverage guard only counts calls made by the fuzzer).
    function resetOk() external {
        require(msg.sender == owner, "owner only");
        for (uint256 i; i < 40; ++i) ok[i] = 0;
    }

    function _sumWithdrawn() internal returns (uint256 sum) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(escrow) && logs[i].topics[0] == RetempoEscrow.Withdrawn.selector) {
                sum += abi.decode(logs[i].data, (uint256));
            }
        }
    }

    // ───────────────────────── creation / funding ─────────────────────────

    function createAndFund(uint256 seed, uint256 amountSeed, uint256 durSeed) external tracked(false) {
        address m = merchants[seed % 3];
        address c = customers[(seed >> 8) % 3];
        address a = arbs[(seed >> 16) % 3];
        bool refundable = (seed >> 24) % 2 == 0;
        uint128 amt = _amt(amountSeed);
        uint32 dur = uint32(bound(durSeed, 1 hours, 60 days));
        bytes32 ref = keccak256(abi.encode("ref", ++nonce));
        vm.prank(m);
        try escrow.createEscrow(ref, c, amt, dur, a, refundable) returns (bytes32 k) {
            keys.push(k);
            ok[0]++;
            if ((seed >> 28) % 8 == 7) return; // leave it Pending (feeds fundPending / cancel)
            usdc.mint(c, amt);
            bytes32 h = escrow.termsHash(k);
            vm.prank(c);
            try escrow.fund(k, a, h) {
                ghostIn += amt;
                ok[1]++;
            } catch {}
        } catch {}
    }

    function fundViaManager(uint256 seed, uint256 amountSeed, uint256 durSeed) external tracked(false) {
        uint128 amt = _amt(amountSeed);
        usdc.mint(manager, amt);
        _mgrFund(seed, amt, uint32(bound(durSeed, 1 hours, 60 days)));
    }

    function _mgrFund(uint256 seed, uint128 amt, uint32 dur) internal {
        bytes32 ref = keccak256(abi.encode("mref", ++nonce));
        address m = merchants[seed % 3];
        address c = customers[(seed >> 8) % 3];
        vm.prank(manager);
        try escrow.fundFromManager(ref, m, c, amt, dur, arbs[(seed >> 16) % 3], (seed >> 24) % 2 == 0) returns (bytes32 k) {
            keys.push(k);
            ghostIn += amt;
            ok[2]++;
        } catch {}
    }

    function fundPending(uint256 ks) external tracked(false) {
        if (keys.length == 0) return;
        bytes32 k = _pickKey(ks, K.Pending);
        RetempoEscrow.Escrow memory e = escrow.getEscrow(k);
        if (e.status != RetempoEscrow.Status.Pending) return;
        usdc.mint(e.customer, e.amount);
        bytes32 h = escrow.termsHash(k);
        vm.prank(e.customer);
        try escrow.fund(k, e.arbitrator, h) {
            ghostIn += e.amount;
            ok[3]++;
        } catch {}
    }

    function cancel(uint256 ks) external tracked(false) {
        if (keys.length == 0) return;
        bytes32 k = _pickKey(ks, K.Pending);
        vm.prank(escrow.getEscrow(k).merchant);
        try escrow.cancelUnfunded(k) {
            ok[4]++;
        } catch {}
    }

    // ───────────────────────── party actions ─────────────────────────

    function claim(uint256 ks) external tracked(false) {
        if (keys.length == 0) return;
        bytes32 k = _pickKey(ks, K.Claimable);
        vm.prank(escrow.getEscrow(k).merchant);
        try escrow.claim(k) {
            ok[5]++;
        } catch {}
    }

    function merchantRefund(uint256 ks, uint256 ms) external tracked(false) {
        if (keys.length == 0) return;
        bytes32 k = _pickKey(ks, K.Free);
        uint256 free = escrow.freeBalanceOf(k);
        if (free == 0) return;
        uint256 amt = 1 + (ms % free) / (1 + (ms >> 128) % 8);
        vm.prank(escrow.getEscrow(k).merchant);
        try escrow.merchantRefund(k, uint128(amt)) {
            ok[6]++;
        } catch {}
    }

    function customerRefund(uint256 ks) external tracked(false) {
        if (keys.length == 0) return;
        bytes32 k = _pickKey(ks, K.Refundable);
        vm.prank(escrow.getEscrow(k).customer);
        try escrow.customerRefundUnvested(k) {
            ok[7]++;
        } catch {}
    }

    function openDispute(uint256 ks, uint256 ms) external tracked(false) {
        if (keys.length == 0) return;
        bytes32 k = _pickKey(ks, K.Disputable);
        uint256 b = escrow.balanceOf(k);
        if (b == 0) return;
        uint256 amt = 1 + (ms % b) / (1 + (ms >> 128) % 4);
        vm.prank(escrow.getEscrow(k).customer);
        try escrow.openDispute(k, uint128(amt), keccak256("evidence")) {
            ok[8]++;
        } catch {}
    }

    function respond(uint256 ks) external tracked(false) {
        if (keys.length == 0) return;
        bytes32 k = _pickKey(ks, K.Respondable);
        vm.prank(escrow.getEscrow(k).merchant);
        try escrow.respondToDispute(k, keccak256("response")) {
            ok[9]++;
        } catch {}
    }

    function resolve(uint256 ks, uint256 ms) external tracked(false) {
        if (keys.length == 0) return;
        bytes32 k = _pickKey(ks, K.Resolvable);
        RetempoEscrow.Escrow memory e = escrow.getEscrow(k);
        uint256 m = ms % (uint256(e.frozen) + 2); // sometimes frozen + 1 (must revert)
        vm.prank(e.arbitrator);
        try escrow.resolveDispute(k, uint128(m), keccak256("ruling")) {
            ok[10]++;
            RetempoEscrow.Escrow memory a = escrow.getEscrow(k);
            if (m > e.frozen) rulingViolation = true;
            if (uint256(a.awarded) - e.awarded != m) rulingViolation = true;
            if (uint256(a.refunded) - e.refunded != uint256(e.frozen) - m) rulingViolation = true;
            if (a.frozen != 0) rulingViolation = true;
        } catch {}
    }

    function expire(uint256 ks, uint256 callerSeed) external tracked(false) {
        if (keys.length == 0) return;
        bytes32 k = _pickKey(ks, K.Expirable);
        vm.prank(accounts[callerSeed % accounts.length]);
        try escrow.expireDispute(k) {
            ok[11]++;
        } catch {}
    }

    function proposeSettlement(uint256 ks, uint256 ms) external tracked(false) {
        if (keys.length == 0) return;
        bytes32 k = _pickKey(ks, K.Active);
        RetempoEscrow.Escrow memory e = escrow.getEscrow(k);
        uint256 scope = e.frozen > 0 ? e.frozen : escrow.balanceOf(k);
        vm.prank(ms % 2 == 0 ? e.merchant : e.customer);
        try escrow.proposeSettlement(k, uint128((ms >> 8) % (scope + 1))) {
            ok[12]++;
        } catch {}
    }

    function acceptSettlement(uint256 ks, uint256 ms) external tracked(false) {
        if (keys.length == 0) return;
        bytes32 k = _pickKey(ks, K.Proposed);
        RetempoEscrow.Escrow memory e = escrow.getEscrow(k);
        address acceptor = e.settlementProposer == e.merchant ? e.customer : e.merchant;
        uint32 id = (ms % 5 == 0 && e.settlementId > 1) ? e.settlementId - 1 : e.settlementId; // sometimes stale
        vm.prank(acceptor);
        try escrow.acceptSettlement(k, e.settlementMerchantAmount, id) {
            ok[13]++;
        } catch {}
    }

    function proposeReplacement(uint256 ks, uint256 ms) external tracked(false) {
        if (keys.length == 0) return;
        bytes32 k = _pickKey(ks, K.Active);
        RetempoEscrow.Escrow memory e = escrow.getEscrow(k);
        vm.prank(ms % 2 == 0 ? e.merchant : e.customer);
        try escrow.proposeArbitratorReplacement(k, arbs[(ms >> 8) % 3]) {
            ok[14]++;
        } catch {}
    }

    function acceptReplacement(uint256 ks) external tracked(false) {
        if (keys.length == 0) return;
        bytes32 k = _pickKey(ks, K.Replacing);
        RetempoEscrow.Escrow memory e = escrow.getEscrow(k);
        address acceptor = e.replacementProposer == e.merchant ? e.customer : e.merchant;
        vm.prank(acceptor);
        try escrow.acceptArbitratorReplacement(k, e.replacementCandidate) {
            ok[15]++;
        } catch {}
    }

    // ───────────────────────── ledger ─────────────────────────

    function withdraw(uint256 seed) external tracked(false) {
        address acct = (seed >> 200) % 8 == 7 ? accounts[seed % accounts.length] : _pickAccount(seed);
        exempt = acct;
        vm.recordLogs();
        vm.prank(acct);
        try escrow.withdraw((seed >> 8) % 2 == 0 ? acct : payouts[(seed >> 16) % 3]) {
            ok[16]++;
        } catch {}
        ghostWithdrawn += _sumWithdrawn();
    }

    function withdrawToPayout(uint256 seed, uint256 callerSeed) external tracked(false) {
        address acct = (seed >> 200) % 8 == 7 ? accounts[seed % accounts.length] : _pickAccount(seed);
        exempt = acct;
        vm.recordLogs();
        vm.prank(accounts[callerSeed % accounts.length]);
        try escrow.withdrawToPayout(acct) {
            ok[17]++;
        } catch {}
        ghostWithdrawn += _sumWithdrawn();
    }

    function setPayout(uint256 seed) external tracked(false) {
        address acct = accounts[seed % accounts.length];
        vm.prank(acct);
        try escrow.setPayoutAddress((seed >> 8) % 3 == 0 ? address(0) : payouts[(seed >> 16) % 3]) {
            ok[18]++;
        } catch {}
    }

    function warp(uint256 dt) external tracked(false) {
        // 1/3 of warps are long (up to 25 days: vesting completion / dispute expiry), the rest are short
        // so escrows spend most of the run mid-life instead of fully vested.
        uint256 step = (dt >> 128) % 3 == 0 ? bound(dt, 1 days, 25 days) : bound(dt, 1 hours, 2 days);
        vm.warp(block.timestamp + step);
        ok[19]++;
    }

    function donate(uint256 amt) external tracked(false) {
        amt = bound(amt, 1, 1_000e6);
        usdc.mint(address(escrow), amt);
        ghostIn += amt;
        ok[20]++;
    }

    // ───────────────────────── role holders (I8) ─────────────────────────

    function pause(uint256 seed) external tracked(true) {
        if (seed % 4 != 0) return; // pause is rare...
        vm.prank(pauser);
        try escrow.pause() {
            ok[21]++;
            pausedLeft = 2 + (seed >> 8) % 4; // ...and always auto-unpaused 2-5 handler calls later
        } catch {}
    }

    function unpause() external tracked(true) {
        vm.prank(admin);
        try escrow.unpause() {
            ok[22]++;
        } catch {}
    }

    function setMinAmount(uint256 v) external tracked(true) {
        vm.prank(configMgr);
        try escrow.setMinAmount(bound(v, 1, 1e6)) {
            ok[23]++;
        } catch {}
    }

    function setMaxEscrowAmount(uint256 v) external tracked(true) {
        vm.prank(configMgr);
        try escrow.setMaxEscrowAmount(bound(v, 1_000e6, 20_000e6)) {
            ok[24]++;
        } catch {}
    }

    function setMaxAggregateExposure(uint256 v) external tracked(true) {
        vm.prank(configMgr);
        try escrow.setMaxAggregateExposure(bound(v, 5_000e6, 100_000e6)) {
            ok[25]++;
        } catch {}
    }

    function setResponseWindow(uint256 v) external tracked(true) {
        vm.prank(configMgr);
        // [1d,5d] is always strictly below the resolution-timeout range [8d,30d]: ordering always holds.
        try escrow.setResponseWindow(uint32(bound(v, 1 days, 5 days))) {
            ok[26]++;
        } catch {}
    }

    function setResolutionTimeout(uint256 v) external tracked(true) {
        vm.prank(configMgr);
        try escrow.setResolutionTimeout(uint32(bound(v, 8 days, 30 days))) {
            ok[27]++;
        } catch {}
    }

    function addArbitrator(uint256 seed) external tracked(true) {
        vm.prank(arbMgr);
        try escrow.addArbitrator(arbs[seed % 3]) {
            ok[28]++;
        } catch {}
    }

    function removeArbitrator(uint256 seed) external tracked(true) {
        if (removedLeft > 0) return; // one outstanding removal at a time; it is re-added automatically
        address a = arbs[seed % 3];
        vm.prank(arbMgr);
        try escrow.removeArbitrator(a) {
            ok[29]++;
            (removedArb, removedLeft) = (a, 2 + (seed >> 8) % 4);
        } catch {}
    }

    /// Admin grants/revokes a privileged role to an arbitrator (creating/removing conflicts).
    function toggleConflict(uint256 seed) external tracked(true) {
        bytes32[3] memory roles = [escrow.PAUSER_ROLE(), escrow.CONFIG_ROLE(), escrow.ARBITRATOR_MANAGER_ROLE()];
        address a = arbs[seed % 3];
        bytes32 role = roles[(seed >> 8) % 3];
        if ((seed >> 16) % 2 == 0) {
            if (conflictLeft > 0) return; // one outstanding conflict at a time; it is revoked automatically
            vm.prank(admin);
            try escrow.grantRole(role, a) {
                ok[30]++;
                (conflictAcct, conflictRole, conflictLeft) = (a, role, 2 + (seed >> 24) % 4);
            } catch {}
        } else {
            vm.prank(admin);
            try escrow.revokeRole(role, a) {
                ok[31]++;
                if (a == conflictAcct && role == conflictRole) conflictLeft = 0;
            } catch {}
        }
    }

    /// Wrong-role callers must never succeed.
    function roleMisuse(uint256 seed) external tracked(true) {
        uint256 i = seed % 6;
        address caller;
        bytes memory data;
        if (i == 0) (caller, data) = (admin, abi.encodeCall(escrow.pause, ()));
        else if (i == 1) (caller, data) = (pauser, abi.encodeCall(escrow.unpause, ()));
        else if (i == 2) (caller, data) = (configMgr, abi.encodeCall(escrow.addArbitrator, (makeAddr("x"))));
        else if (i == 3) (caller, data) = (arbMgr, abi.encodeCall(escrow.setMinAmount, (1)));
        else if (i == 4) (caller, data) = (admin, abi.encodeCall(escrow.setMaxEscrowAmount, (1e6)));
        else (caller, data) = (pauser, abi.encodeCall(escrow.removeArbitrator, (arbs[0])));
        vm.prank(caller);
        (bool success,) = address(escrow).call(data);
        if (success) misuseSucceeded = true;
        ok[32]++;
    }
}
