// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {RetempoEscrow} from "../../RetempoEscrow.sol";
import {RetempoSubscriptionManager as M} from "../../RetempoSubscriptionManager.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Stateful handler for the subscription manager (with the real escrow behind it). Every manager call is
///      wrapped in try/catch; mandate / subscription state is snapshotted with the public getters right before
///      each payment call and verified right after (success) or compared for equality (revert).
contract ManagerInvariantHandler is Test {
    struct PlanG {
        bytes32 key;
        address merchant;
        address payoutG;
        bool activeG;
        uint128 amount;
        uint32 interval;
        uint32 trial;
        uint32 grace;
        uint32 vest;
        address arbitrator;
        bool refundable;
    }

    struct SubG {
        bytes32 key;
        bytes32 ref;
        address customer;
        bytes32 planKey;
        uint128 amount;
        uint32 interval;
        uint32 grace;
        uint32 trial;
        address accepted;
        uint40 subscribedAt;
        uint32 count; // successful payments (manual + recurring)
        uint40 lastPay;
        uint40 expectedNext;
        bool canceled;
        uint32 cancelCount; // payment count frozen at cancellation
        uint32 mNonce;
        uint128 mPer;
        uint128 mTotal;
        uint40 mExpiry;
        bool mActive;
        uint256 deactSum; // recurring sum of the current nonce frozen at deactivation
    }

    /// @dev Everything observable around one payment, read with the public getters.
    struct Pre {
        bytes32 subKey;
        bytes32 planKey;
        address customer;
        bool exists;
        M.Subscription s;
        M.Mandate m;
        M.Plan p;
        uint256 custBal;
        uint256 payoutBal;
        uint256 locked;
        uint256 escBal;
        uint256 mgrBal;
        uint256 maxPay;
    }

    enum K { Any, Active, Chargeable, Due, NoMandate, HasMandate }

    uint256 internal constant MAX_PLANS = 12;
    uint256 internal constant MAX_SUBS = 24;
    uint256 public constant NOK = 32;
    // ok[] indices
    uint256 internal constant OK_PLAN = 0;
    uint256 internal constant OK_SUB = 1;
    uint256 internal constant OK_MANDATE = 2;
    uint256 internal constant OK_CHARGE = 3;
    uint256 internal constant OK_RENEW = 4;
    uint256 internal constant OK_ESCROWPAY = 5;
    uint256 internal constant OK_REVOKE = 6;
    uint256 internal constant OK_CANCEL = 7;
    uint256 internal constant OK_MCANCEL = 8;
    uint256 internal constant OK_PLANACTIVE = 9;
    uint256 internal constant OK_PAYOUT = 10;
    uint256 internal constant OK_WARP = 11;
    uint256 internal constant OK_DONATE = 12;
    uint256 internal constant OK_PAUSE = 13;
    uint256 internal constant OK_UNPAUSE = 14;
    uint256 internal constant OK_SETMAX = 15;
    uint256 internal constant OK_ROLE = 16;
    uint256 internal constant OK_MISUSE = 17;
    uint256 internal constant OK_STRANGER = 18;
    uint256 internal constant OK_ESCFAULT = 19;
    uint256 internal constant OK_TWEAK = 20;
    uint256 internal constant OK_CHARGE_DIRECT = 21;
    uint256 internal constant OK_CHARGE_ESCROW = 22;
    uint256 internal constant OK_REBASE = 23;
    uint256 internal constant OK_REPLACE = 24;
    uint256 internal constant OK_SQUEEZE = 25;
    uint256 internal constant OK_SUB_TRIAL = 26;
    uint256 internal constant OK_SUB_PAID = 27;
    uint256 internal constant OK_RENEW_ESCROW = 28;

    M public immutable mgr;
    RetempoEscrow public immutable escrow;
    MockUSDC public immutable usdc;
    address public immutable admin;
    address public immutable pauser;
    address public immutable configMgr;
    address public immutable arbMgr;
    address internal immutable owner;

    address[] public merchants;
    address[] public customers;
    address[] public payouts;
    address[] public arbs;
    address[] public actors;
    address public outsider;
    address public extra; // transient holder of PAUSER / CONFIG roles granted by the admin
    address public sink;

    PlanG[] internal planG;
    SubG[] internal subs;
    bytes32[] public escrowKeys;
    mapping(bytes32 => uint256) public recurSum; // keccak(subKey, nonce) => sum of recurring amounts
    mapping(bytes32 => address) internal planMerchant;
    mapping(address => uint256) public minted;
    mapping(address => uint256) public paid; // USDC the manager/escrow pulled from the customer
    mapping(address => uint256) public sunk; // USDC the customer moved to the sink itself

    uint256 public ghostDonated; // USDC donated directly to the manager
    uint256 public ghostLocked; // sum of escrow-plan payments
    uint256 public ghostDirect; // sum of direct-plan payments
    uint256 public nonce;
    uint256 internal donatedNow;
    uint256[32] public ok;

    // violation flags (each backs one invariant)
    bool public vRevoked; // I5: a payment succeeded on a revoked / replaced / canceled / expired mandate
    bool public vCaps; // I6: per-charge / total cap or spent accounting broken
    bool public vPeriod; // I7: a period was charged twice / early / bad nextChargeAt
    bool public vRole; // I8: a role/stranger action changed world state
    bool public vMisuse; // I8: an unauthorized call succeeded
    bool public vMgrBal; // I9: manager balance changed outside a donation
    bool public vAllowance; // I9: manager left a nonzero allowance to the escrow
    bool public vConserve; // conservation of customer / payout / escrow funds
    bool public vEscrow; // routed escrow terms mismatch
    bool public vPaymentCap; // payment above maxPaymentAmount at execution time
    bool public vFail; // a reverted call changed state
    bool public vLive; // a payment that should have succeeded reverted

    // transient-fault bookkeeping (always repaired a few handler calls later)
    uint256 internal pausedLeft;
    uint256 internal escPausedLeft;
    uint256 internal removedLeft;
    address internal removedArb;
    uint256 internal roleLeft;
    bytes32 internal roleRole;
    uint256 internal squeezeLeft;

    modifier act(bool isRole) {
        _tick();
        donatedNow = 0;
        uint256 mb = usdc.balanceOf(address(mgr));
        bytes32 w = isRole ? _world() : bytes32(0);
        _;
        if (usdc.balanceOf(address(mgr)) != mb + donatedNow) vMgrBal = true;
        if (usdc.allowance(address(mgr), address(escrow)) != 0) vAllowance = true;
        if (isRole && _world() != w) vRole = true;
    }

    constructor(
        M m_,
        RetempoEscrow e_,
        MockUSDC u_,
        address admin_,
        address pauser_,
        address configMgr_,
        address arbMgr_,
        address arbA,
        address arbB
    ) {
        owner = msg.sender;
        mgr = m_;
        escrow = e_;
        usdc = u_;
        admin = admin_;
        pauser = pauser_;
        configMgr = configMgr_;
        arbMgr = arbMgr_;
        arbs.push(arbA);
        arbs.push(arbB);
        outsider = makeAddr("mh-outsider");
        extra = makeAddr("mh-extra");
        sink = makeAddr("mh-sink");
        actors.push(outsider);
        for (uint256 i; i < 2; ++i) {
            address m = makeAddr(string.concat("mh-m", vm.toString(i)));
            merchants.push(m);
            actors.push(m);
        }
        for (uint256 i; i < 3; ++i) {
            address c = makeAddr(string.concat("mh-c", vm.toString(i)));
            customers.push(c);
            actors.push(c);
            payouts.push(makeAddr(string.concat("mh-p", vm.toString(i))));
            _mintTo(c, 100_000e6);
            vm.prank(c);
            u_.approve(address(m_), type(uint256).max);
        }
        actors.push(admin_);
        actors.push(pauser_);
        actors.push(configMgr_);
        actors.push(arbMgr_);
        actors.push(arbA);
    }

    // ───────────────────────── views for the invariant contract ─────────────────────────

    function subsLength() external view returns (uint256) {
        return subs.length;
    }

    function subAt(uint256 i) external view returns (SubG memory) {
        return subs[i];
    }

    function plansLength() external view returns (uint256) {
        return planG.length;
    }

    function planAt(uint256 i) external view returns (PlanG memory) {
        return planG[i];
    }

    function escrowKeysLength() external view returns (uint256) {
        return escrowKeys.length;
    }

    function customersLength() external view returns (uint256) {
        return customers.length;
    }

    function payoutsLength() external view returns (uint256) {
        return payouts.length;
    }

    function resetOk() external {
        require(msg.sender == owner, "owner only");
        for (uint256 i; i < 32; ++i) ok[i] = 0;
    }

    function nonceKey(bytes32 subKey, uint32 n) public pure returns (bytes32) {
        return keccak256(abi.encode(subKey, n));
    }

    // ───────────────────────── internals: bookkeeping ─────────────────────────

    function _mintTo(address c, uint256 amt) internal {
        usdc.mint(c, amt);
        minted[c] += amt;
    }

    /// @dev ~7/8 of the time repairs the customer's balance and allowance so payments can succeed; the rest of
    ///      the time leaves them untouched so the insufficient-funds paths stay covered.
    function _fundCustomer(address c, uint256 seed) internal {
        if ((seed >> 208) % 8 == 0) return;
        if (usdc.balanceOf(c) < 5_000e6) _mintTo(c, 100_000e6);
        if (usdc.allowance(c, address(mgr)) < 1e30) {
            vm.prank(c);
            usdc.approve(address(mgr), type(uint256).max);
        }
    }

    function _tick() internal {
        if (pausedLeft > 0) {
            if (!mgr.paused()) {
                pausedLeft = 0;
            } else if (--pausedLeft == 0) {
                vm.prank(admin);
                try mgr.unpause() {} catch {}
            }
        }
        if (escPausedLeft > 0) {
            if (!escrow.paused()) {
                escPausedLeft = 0;
            } else if (--escPausedLeft == 0) {
                vm.prank(admin);
                try escrow.unpause() {} catch {}
            }
        }
        if (removedLeft > 0 && --removedLeft == 0) {
            vm.prank(arbMgr);
            try escrow.addArbitrator(removedArb) {} catch {
                removedLeft = 1;
            }
        }
        if (roleLeft > 0 && --roleLeft == 0) {
            vm.prank(admin);
            try mgr.revokeRole(roleRole, extra) {} catch {}
        }
        if (squeezeLeft > 0 && --squeezeLeft == 0) {
            vm.prank(configMgr);
            try mgr.setMaxPaymentAmount(10_000e6) {} catch {}
        }
    }

    /// @dev Hash of everything role holders / strangers must never be able to change.
    function _world() internal view returns (bytes32 h) {
        for (uint256 i; i < subs.length; ++i) {
            h = keccak256(abi.encode(h, mgr.getSubscription(subs[i].key), mgr.getMandate(subs[i].key)));
        }
        for (uint256 i; i < planG.length; ++i) h = keccak256(abi.encode(h, mgr.getPlan(planG[i].key)));
        for (uint256 i; i < customers.length; ++i) {
            h = keccak256(abi.encode(h, usdc.balanceOf(customers[i]), usdc.allowance(customers[i], address(mgr))));
        }
        h = keccak256(abi.encode(h, escrow.totalLocked(), usdc.balanceOf(address(escrow))));
    }

    function _pre(bytes32 subKey, bytes32 planKey, address customer) internal view returns (Pre memory a) {
        a.subKey = subKey;
        a.planKey = planKey;
        a.customer = customer;
        a.s = mgr.getSubscription(subKey);
        a.exists = a.s.status != M.SubStatus.None;
        a.m = mgr.getMandate(subKey);
        a.p = mgr.getPlan(planKey);
        a.custBal = usdc.balanceOf(customer);
        a.payoutBal = usdc.balanceOf(a.p.payout);
        a.locked = escrow.totalLocked();
        a.escBal = usdc.balanceOf(address(escrow));
        a.mgrBal = usdc.balanceOf(address(mgr));
        a.maxPay = mgr.maxPaymentAmount();
    }

    function _subPre(uint256 i) internal view returns (Pre memory) {
        return _pre(subs[i].key, subs[i].planKey, subs[i].customer);
    }

    /// @dev A reverted call must leave every observable value unchanged.
    function _verifyFail(Pre memory a) internal {
        Pre memory b = _pre(a.subKey, a.planKey, a.customer);
        if (keccak256(abi.encode(a)) != keccak256(abi.encode(b))) vFail = true;
    }

    // ───────────────────────── selection helpers ─────────────────────────

    function _match(bytes32 k, K kind) internal view returns (bool) {
        M.Subscription memory s = mgr.getSubscription(k);
        if (s.status != M.SubStatus.Active) return false;
        if (kind == K.Active) return true;
        if (kind == K.Chargeable) {
            (bool can,) = mgr.canCharge(k);
            return can;
        }
        if (kind == K.Due) return block.timestamp >= s.nextChargeAt;
        M.Mandate memory m = mgr.getMandate(k);
        if (kind == K.HasMandate) return m.active;
        return !m.active || block.timestamp >= m.expiry || uint256(m.spent) + s.amount > m.totalCap; // NoMandate
    }

    /// @dev First subscription (cyclic scan from seed % n) in the wanted state; ~1/8 blind picks keep revert paths.
    function _pickSub(uint256 seed, K kind) internal view returns (uint256) {
        uint256 n = subs.length;
        uint256 start = seed % n;
        if (kind == K.Any || (seed >> 200) % 8 == 7) return start;
        for (uint256 j; j < n; ++j) {
            uint256 i = (start + j) % n;
            if (_match(subs[i].key, kind)) return i;
        }
        return start;
    }

    function _pickPlan(uint256 seed) internal view returns (uint256) {
        uint256 n = planG.length;
        uint256 start = seed % n;
        if ((seed >> 200) % 8 == 7) return start;
        uint256 mx = mgr.maxPaymentAmount();
        for (uint256 j; j < n; ++j) {
            uint256 i = (start + j) % n;
            if (mgr.getPlan(planG[i].key).active && planG[i].amount <= mx) return i;
        }
        return start;
    }

    function _amt(uint256 s) internal view returns (uint128) {
        uint256 mx = mgr.maxPaymentAmount();
        if ((s >> 200) % 16 == 15) return uint128(bound(s, 1, mx + 1_000e6));
        uint256 hi = mx < 500e6 ? mx : 500e6;
        if (s % 2 == 0 && hi > 60e6) hi = 60e6;
        return uint128(bound(s >> 8, 10_000, hi));
    }

    // ───────────────────────── payment verification ─────────────────────────

    /// @dev I7: due-time ordering, no period charged twice, strict nextChargeAt progress.
    function _vTiming(Pre memory a, Pre memory b, SubG storage g) internal {
        uint256 t = block.timestamp;
        uint256 preNext = a.exists ? a.s.nextChargeAt : t;
        uint256 preCount = a.exists ? a.s.chargeCount : 0;
        uint256 grace = b.s.grace;
        uint256 interval = b.s.interval;
        if (a.exists && a.s.status != M.SubStatus.Active) vRevoked = true;
        if (b.s.chargeCount != preCount + 1 || preCount != g.count) vPeriod = true;
        if (t < preNext) vPeriod = true;
        uint256 exp = (t > preNext + grace ? t : preNext) + interval;
        if (b.s.nextChargeAt != exp) vPeriod = true;
        if (b.s.nextChargeAt <= t || b.s.nextChargeAt < preNext + interval) vPeriod = true;
        if (g.count > 0 && t + grace < uint256(g.lastPay) + interval) vPeriod = true;
        uint256 first = uint256(g.subscribedAt) + g.trial;
        if (t < first || b.s.chargeCount > 1 + (t - first) / interval) vPeriod = true;
    }

    /// @dev Conservation: customer decrease == payout increase (direct) or escrow totalLocked increase (escrow).
    function _vFunds(Pre memory a, Pre memory b) internal {
        uint256 amount = b.s.amount;
        if (
            a.exists
                && (a.s.customer != b.s.customer || a.s.amount != b.s.amount || a.s.planKey != b.s.planKey
                    || a.s.interval != b.s.interval || a.s.grace != b.s.grace
                    || a.s.acceptedArbitrator != b.s.acceptedArbitrator)
        ) vConserve = true;
        if (amount != a.p.amount || b.s.customer != a.customer) vConserve = true;
        if (b.custBal > a.custBal || a.custBal - b.custBal != amount) vConserve = true;
        if (b.mgrBal != a.mgrBal) vMgrBal = true;
        if (amount > a.maxPay) vPaymentCap = true;
        if (a.p.vestDuration == 0) {
            if (b.payoutBal != a.payoutBal + amount || b.locked != a.locked || b.escBal != a.escBal) vConserve = true;
        } else {
            if (b.locked != a.locked + amount || b.escBal != a.escBal + amount || b.payoutBal != a.payoutBal) {
                vConserve = true;
            }
        }
    }

    function _vEscrow(Pre memory a, Pre memory b) internal {
        bytes32 key = keccak256(abi.encode(a.p.merchant, nonceKey(a.subKey, b.s.chargeCount)));
        RetempoEscrow.Escrow memory e = escrow.getEscrow(key);
        if (
            key != escrow.escrowKey(a.p.merchant, nonceKey(a.subKey, b.s.chargeCount)) || e.merchant != a.p.merchant
                || e.customer != a.customer || e.arbitrator != a.p.arbitrator
                || e.arbitrator != b.s.acceptedArbitrator || e.amount != b.s.amount
                || e.status != RetempoEscrow.Status.Active || e.vestDuration != a.p.vestDuration
                || e.customerMayRefundUnvested != a.p.customerMayRefundUnvested || e.vestStart != block.timestamp
                || e.claimed != 0 || e.refunded != 0 || escrow.balanceOf(key) != b.s.amount
        ) vEscrow = true;
        escrowKeys.push(key);
    }

    /// @dev I5 / I6 on the pre-call snapshot; recurring charges touch only `spent`, manual ones nothing.
    function _vMandate(Pre memory a, Pre memory b, bool rec) internal {
        if (!rec) {
            if (keccak256(abi.encode(a.m)) != keccak256(abi.encode(b.m))) vCaps = true;
            return;
        }
        if (a.m.nonce == 0 || !a.m.active || block.timestamp >= a.m.expiry || a.s.status != M.SubStatus.Active) {
            vRevoked = true;
        }
        if (a.s.amount > a.m.perChargeCap || uint256(a.m.spent) + a.s.amount > a.m.totalCap) vCaps = true;
        if (
            b.m.spent != a.m.spent + a.s.amount || b.m.nonce != a.m.nonce || b.m.active != a.m.active
                || b.m.totalCap != a.m.totalCap || b.m.perChargeCap != a.m.perChargeCap || b.m.expiry != a.m.expiry
        ) vCaps = true;
    }

    function _verifyPay(Pre memory a, bool rec, uint256 si) internal {
        Pre memory b = _pre(a.subKey, a.planKey, a.customer);
        SubG storage g = subs[si];
        _vTiming(a, b, g);
        _vFunds(a, b);
        _vMandate(a, b, rec);
        uint256 amount = b.s.amount;
        if (a.p.vestDuration != 0) {
            _vEscrow(a, b);
            ghostLocked += amount;
            ok[OK_ESCROWPAY]++;
        } else {
            ghostDirect += amount;
        }
        paid[a.customer] += amount;
        if (a.exists && block.timestamp > uint256(a.s.nextChargeAt) + b.s.grace) ok[OK_REBASE]++;
        if (rec) recurSum[nonceKey(a.subKey, b.m.nonce)] += amount;
        g.count = b.s.chargeCount;
        g.lastPay = uint40(block.timestamp);
        g.expectedNext = b.s.nextChargeAt;
    }

    // ───────────────────────── payment drivers ─────────────────────────

    function _liveRec(Pre memory a) internal view returns (bool) {
        (bool can,) = mgr.canCharge(a.subKey);
        return can && _downstreamUp(a);
    }

    function _liveRenew(Pre memory a) internal view returns (bool) {
        if (a.s.status != M.SubStatus.Active || block.timestamp < a.s.nextChargeAt || a.s.amount > a.maxPay) return false;
        if (usdc.allowance(a.customer, address(mgr)) < a.s.amount || a.custBal < a.s.amount) return false;
        return _downstreamUp(a);
    }

    function _downstreamUp(Pre memory a) internal view returns (bool) {
        if (mgr.paused()) return false;
        return a.p.vestDuration == 0 || (!escrow.paused() && escrow.isArbitrator(a.p.arbitrator));
    }

    function _doCharge(uint256 i, address caller) internal returns (bool) {
        Pre memory a = _subPre(i);
        bool live = _liveRec(a);
        vm.prank(caller);
        try mgr.charge(a.subKey) {
            _verifyPay(a, true, i);
            ok[OK_CHARGE]++;
            ok[a.p.vestDuration == 0 ? OK_CHARGE_DIRECT : OK_CHARGE_ESCROW]++;
            return true;
        } catch {
            _verifyFail(a);
            if (live) vLive = true;
            return false;
        }
    }

    function _doRenew(uint256 i, address caller) internal returns (bool) {
        Pre memory a = _subPre(i);
        bool live = caller == a.customer && _liveRenew(a);
        vm.prank(caller);
        try mgr.renew(a.subKey) {
            _verifyPay(a, false, i);
            ok[OK_RENEW]++;
            if (a.p.vestDuration != 0) ok[OK_RENEW_ESCROW]++;
            return true;
        } catch {
            _verifyFail(a);
            if (live) vLive = true;
            return false;
        }
    }

    function _doSubscribe(address c, bytes32 ref, uint256 pi, address acc) internal returns (bool) {
        PlanG memory pg = planG[pi];
        bytes32 sk = mgr.subscriptionKey(c, ref);
        Pre memory a = _pre(sk, pg.key, c);
        vm.prank(c);
        try mgr.subscribe(ref, pg.key, acc) returns (bytes32 k) {
            if (k != sk) vConserve = true;
            subs.push();
            SubG storage g = subs[subs.length - 1];
            g.key = sk;
            g.ref = ref;
            g.customer = c;
            g.planKey = pg.key;
            g.amount = pg.amount;
            g.interval = pg.interval;
            g.grace = pg.grace;
            g.trial = pg.trial;
            g.accepted = acc;
            g.subscribedAt = uint40(block.timestamp);
            g.expectedNext = uint40(block.timestamp + pg.trial);
            ok[OK_SUB]++;
            if (pg.trial == 0) {
                ok[OK_SUB_PAID]++;
                _verifyPay(a, false, subs.length - 1);
            } else {
                ok[OK_SUB_TRIAL]++;
                Pre memory b = _pre(sk, pg.key, c);
                if (b.custBal != a.custBal || b.s.chargeCount != 0 || b.s.nextChargeAt != g.expectedNext) {
                    vConserve = true;
                }
            }
            return true;
        } catch {
            _verifyFail(a);
            return false;
        }
    }

    function _createPlan(uint256 mi, uint256 ai, PlanG memory n) internal returns (bool, uint256) {
        if (planG.length >= MAX_PLANS) return (false, 0);
        address m = merchants[mi % 2];
        address arbitr = n.vest == 0 ? address(0) : arbs[ai % 2];
        bytes32 ref = keccak256(abi.encode("pref", ++nonce));
        vm.prank(m);
        try mgr.createPlan(ref, payouts[mi % 3], n.amount, n.interval, n.trial, n.grace, n.vest, arbitr, n.refundable)
        returns (bytes32 k) {
            planG.push(n);
            PlanG storage g = planG[planG.length - 1];
            g.key = k;
            g.merchant = m;
            g.payoutG = payouts[mi % 3];
            g.activeG = true;
            g.arbitrator = arbitr;
            planMerchant[k] = m;
            ok[OK_PLAN]++;
            return (true, planG.length - 1);
        } catch {
            return (false, 0);
        }
    }

    function _planTerms(uint128 amount, uint32 interval, uint32 trial, uint32 grace, uint32 vest, bool refundable)
        internal
        pure
        returns (PlanG memory n)
    {
        n.amount = amount;
        n.interval = interval;
        n.trial = trial;
        n.grace = grace;
        n.vest = vest;
        n.refundable = refundable;
    }

    function _createMandate(uint256 i, uint128 per, uint128 total, uint40 expiry) internal returns (bool) {
        SubG storage g = subs[i];
        Pre memory a = _subPre(i);
        vm.prank(g.customer);
        try mgr.createMandate(g.key, per, total, expiry) {
            M.Mandate memory m = mgr.getMandate(g.key);
            if (a.m.active) ok[OK_REPLACE]++;
            if (
                m.nonce != a.m.nonce + 1 || m.spent != 0 || !m.active || m.perChargeCap != per || m.totalCap != total
                    || m.expiry != expiry || a.s.status != M.SubStatus.Active
            ) vCaps = true;
            g.mNonce = m.nonce;
            g.mPer = per;
            g.mTotal = total;
            g.mExpiry = expiry;
            g.mActive = true;
            ok[OK_MANDATE]++;
            return true;
        } catch {
            _verifyFail(a);
            return false;
        }
    }

    function _revoke(uint256 i) internal returns (bool) {
        SubG storage g = subs[i];
        Pre memory a = _subPre(i);
        vm.prank(g.customer);
        try mgr.revokeMandate(g.key) {
            g.mActive = false;
            g.deactSum = recurSum[nonceKey(g.key, g.mNonce)];
            ok[OK_REVOKE]++;
            return true;
        } catch {
            _verifyFail(a);
            return false;
        }
    }

    function _cancel(uint256 i, bool byMerchant) internal returns (bool) {
        SubG storage g = subs[i];
        Pre memory a = _subPre(i);
        vm.prank(byMerchant ? planMerchant[g.planKey] : g.customer);
        try mgr.cancelSubscription(g.key) {
            g.canceled = true;
            g.cancelCount = g.count;
            g.mActive = false;
            g.deactSum = recurSum[nonceKey(g.key, g.mNonce)];
            ok[byMerchant ? OK_MCANCEL : OK_CANCEL]++;
            return true;
        } catch {
            _verifyFail(a);
            return false;
        }
    }

    // ───────────────────────── seeding API (explicit parameters; reverts unless the step succeeds) ─────────────────────────

    /// @param who merchant index = who % 2, arbitrator index = who / 2
    function seedPlan(uint256 who, PlanG memory terms) external returns (uint256 pi) {
        bool success;
        terms.refundable = who % 2 == 0;
        (success, pi) = _createPlan(who % 2, who / 2, terms);
        require(success, "seedPlan");
    }

    function seedSub(uint256 ci, uint256 pi) external returns (uint256) {
        PlanG storage p = planG[pi];
        bytes32 ref = keccak256(abi.encode("sref", ++nonce));
        require(_doSubscribe(customers[ci % 3], ref, pi, p.vest == 0 ? address(0) : p.arbitrator), "seedSub");
        return subs.length - 1;
    }

    function seedMandate(uint256 si, uint128 per, uint128 total, uint256 expiryOffset) external {
        require(_createMandate(si, per, total, uint40(block.timestamp + expiryOffset)), "seedMandate");
    }

    function seedCharge(uint256 si) external {
        require(_doCharge(si, outsider), "seedCharge");
    }

    function seedRenew(uint256 si) external {
        require(_doRenew(si, subs[si].customer), "seedRenew");
    }

    function seedRevoke(uint256 si) external {
        require(_revoke(si), "seedRevoke");
    }

    function seedCancel(uint256 si, bool byMerchant) external {
        require(_cancel(si, byMerchant), "seedCancel");
    }

    function seedWarp(uint256 dt) external {
        vm.warp(block.timestamp + dt);
    }

    // ───────────────────────── core actions ─────────────────────────

    function _fuzzTerms(uint256 seed, uint256 a) internal view returns (PlanG memory n) {
        uint32 interval = uint32(bound(a, 1 days, seed % 2 == 0 ? 14 days : 60 days));
        n.interval = interval;
        n.amount = _amt(a);
        n.vest = (seed >> 8) % 2 == 0 ? 0 : uint32(bound(seed >> 16, 1 hours, 30 days));
        n.trial = (seed >> 24) % 3 == 0 ? uint32(bound(a >> 64, 1 days, 10 days)) : 0;
        n.grace = (seed >> 28) % 4 == 0 ? 0 : uint32(bound(a >> 128, 1 hours, interval - 1));
        if ((seed >> 200) % 16 == 15) n.grace = interval; // invalid on purpose
        n.refundable = (seed >> 48) % 2 == 0;
    }

    function createPlan(uint256 seed, uint256 a) external act(false) {
        _createPlan(seed >> 32, seed >> 40, _fuzzTerms(seed, a));
    }

    function subscribe(uint256 seed, uint256 ps) external act(false) {
        if (subs.length >= MAX_SUBS || planG.length == 0) return;
        address c = customers[seed % 3];
        uint256 pi = _pickPlan(ps);
        bytes32 ref = keccak256(abi.encode("sref", ++nonce));
        if ((seed >> 200) % 8 == 7) {
            SubG storage old = subs[(seed >> 8) % subs.length]; // duplicate reference (SubscriptionExists)
            (c, ref) = (old.customer, old.ref);
        }
        PlanG storage p = planG[pi];
        address acc = p.vest == 0 ? address(0) : p.arbitrator;
        if ((seed >> 216) % 16 == 15) acc = acc == address(0) ? arbs[0] : address(0); // wrong arbitrator
        _fundCustomer(c, seed);
        _doSubscribe(c, ref, pi, acc);
    }

    function createMandate(uint256 ks, uint256 ms) external act(false) {
        if (subs.length == 0) return;
        uint256 i = _pickSub(ks, (ms >> 24) % 4 == 0 ? K.HasMandate : K.NoMandate);
        uint128 amt = mgr.getSubscription(subs[i].key).amount;
        if (amt == 0) amt = subs[i].amount;
        uint128 per = ms % 4 == 0 ? amt * 2 : amt;
        uint128 total = per * uint128(1 + (ms >> 8) % 4);
        uint40 expiry = uint40(block.timestamp + bound(ms >> 16, 1 days, 120 days));
        if ((ms >> 200) % 16 == 15) per = amt - 1; // per-charge cap below price: InvalidMandateCaps
        _createMandate(i, per, total, expiry);
    }

    function charge(uint256 ks, uint256 cs) external act(false) {
        if (subs.length == 0) return;
        uint256 i = _pickSub(ks, K.Chargeable);
        _fundCustomer(subs[i].customer, cs);
        _doCharge(i, actors[cs % actors.length]); // charge is permissionless: any caller
    }

    function renew(uint256 ks, uint256 cs) external act(false) {
        if (subs.length == 0) return;
        uint256 i = _pickSub(ks, K.Due);
        _fundCustomer(subs[i].customer, cs);
        _doRenew(i, (cs >> 200) % 8 == 7 ? actors[cs % actors.length] : subs[i].customer);
    }

    function revoke(uint256 ks) external act(false) {
        if (subs.length == 0 || (ks >> 8) % 2 != 0) return; // revocations are rationed to keep mandates alive
        _revoke(_pickSub(ks, K.HasMandate));
    }

    function cancel(uint256 ks, uint256 ms) external act(false) {
        if (subs.length == 0 || (ms >> 8) % 4 != 0) return; // cancellations are rationed
        _cancel(_pickSub(ks, K.Active), ms % 2 == 0);
    }

    function setPlanActive(uint256 seed) external act(false) {
        if (planG.length == 0) return;
        PlanG storage g = planG[seed % planG.length];
        bool want = !g.activeG;
        if (g.activeG && (seed >> 8) % 4 != 0) return; // deactivation is rare; reactivation is likely
        vm.prank(g.merchant);
        try mgr.setPlanActive(g.key, want) {
            g.activeG = want;
            ok[OK_PLANACTIVE]++;
        } catch {}
    }

    function setPlanPayout(uint256 seed) external act(false) {
        if (planG.length == 0) return;
        PlanG storage g = planG[seed % planG.length];
        address np = (seed >> 200) % 16 == 15 ? address(0) : payouts[(seed >> 8) % 3];
        vm.prank(g.merchant);
        try mgr.setPlanPayout(g.key, np) {
            g.payoutG = np;
            ok[OK_PAYOUT]++;
        } catch {}
    }

    function warp(uint256 dt) external act(false) {
        uint256 step = (dt >> 128) % 3 == 0 ? bound(dt, 1 days, 40 days) : bound(dt, 1 hours, 2 days);
        vm.warp(block.timestamp + step);
        ok[OK_WARP]++;
    }

    /// @dev Donations to the manager must be tracked: it must hold nothing else (I9).
    function donate(uint256 amt) external act(false) {
        amt = bound(amt, 1, 1_000e6);
        usdc.mint(address(mgr), amt);
        ghostDonated += amt;
        donatedNow = amt;
        ok[OK_DONATE]++;
    }

    function customerTweak(uint256 seed) external act(false) {
        address c = customers[seed % 3];
        uint256 kind = (seed >> 8) % 4;
        if (kind == 0) {
            vm.prank(c);
            usdc.approve(address(mgr), 0);
        } else if (kind == 1) {
            uint256 bal = usdc.balanceOf(c);
            vm.prank(c);
            usdc.transfer(sink, bal);
            sunk[c] += bal;
        } else {
            vm.prank(c);
            usdc.approve(address(mgr), type(uint256).max);
        }
        ok[OK_TWEAK]++;
    }

    // ───────────────────────── role holders / strangers (I8) ─────────────────────────

    function pause(uint256 seed) external act(true) {
        if (seed % 4 != 0) return; // pause is rare...
        address who = (seed >> 8) % 2 == 0 && mgr.hasRole(mgr.PAUSER_ROLE(), extra) ? extra : pauser;
        vm.prank(who);
        try mgr.pause() {
            ok[OK_PAUSE]++;
            pausedLeft = 2 + (seed >> 16) % 4; // ...and auto-unpaused 2-5 handler calls later
        } catch {}
    }

    function unpause() external act(true) {
        vm.prank(admin);
        try mgr.unpause() {
            ok[OK_UNPAUSE]++;
        } catch {}
    }

    function setMaxPaymentAmount(uint256 v, uint256 seed) external act(true) {
        address who = seed % 2 == 0 && mgr.hasRole(mgr.CONFIG_ROLE(), extra) ? extra : configMgr;
        vm.prank(who);
        try mgr.setMaxPaymentAmount(bound(v, 1_000e6, 10_000e6)) {
            ok[OK_SETMAX]++;
        } catch {}
    }

    /// @dev Temporarily drops the ceiling below some plan prices (auto-restored) so PaymentLimitExceeded and the
    ///      "no payment above the ceiling" property are exercised.
    function squeezeLimit(uint256 v) external act(true) {
        if (squeezeLeft > 0) return;
        vm.prank(configMgr);
        try mgr.setMaxPaymentAmount(bound(v, 10_000, 120e6)) {
            ok[OK_SQUEEZE]++;
            squeezeLeft = 2 + v % 3;
        } catch {}
    }

    function roleToggle(uint256 seed) external act(true) {
        bytes32 role = seed % 2 == 0 ? mgr.PAUSER_ROLE() : mgr.CONFIG_ROLE();
        if ((seed >> 8) % 2 == 0) {
            if (roleLeft > 0) return; // one outstanding grant at a time; revoked automatically
            vm.prank(admin);
            try mgr.grantRole(role, extra) {
                ok[OK_ROLE]++;
                (roleRole, roleLeft) = (role, 2 + (seed >> 16) % 4);
            } catch {}
        } else {
            vm.prank(admin);
            try mgr.revokeRole(role, extra) {
                ok[OK_ROLE]++;
                if (role == roleRole) roleLeft = 0;
            } catch {}
        }
    }

    function escrowFault(uint256 seed) external act(true) {
        if (seed % 2 != 0) return; // rare
        if ((seed >> 8) % 2 == 0) {
            if (escPausedLeft > 0) return;
            vm.prank(pauser);
            try escrow.pause() {
                ok[OK_ESCFAULT]++;
                escPausedLeft = 2 + (seed >> 16) % 4;
            } catch {}
        } else {
            if (removedLeft > 0) return;
            address a = arbs[(seed >> 16) % 2];
            vm.prank(arbMgr);
            try escrow.removeArbitrator(a) {
                ok[OK_ESCFAULT]++;
                (removedArb, removedLeft) = (a, 2 + (seed >> 24) % 4);
            } catch {}
        }
    }

    /// @dev Wrong-role callers must never succeed.
    function roleMisuse(uint256 seed) external act(true) {
        uint256 i = seed % 14;
        address caller;
        bytes memory data;
        if (i == 0) (caller, data) = (admin, abi.encodeCall(mgr.pause, ()));
        else if (i == 1) (caller, data) = (pauser, abi.encodeCall(mgr.unpause, ()));
        else if (i == 2) (caller, data) = (configMgr, abi.encodeCall(mgr.pause, ()));
        else if (i == 3) (caller, data) = (outsider, abi.encodeCall(mgr.setMaxPaymentAmount, (1_000e6)));
        else if (i == 4) (caller, data) = (admin, abi.encodeCall(mgr.setMaxPaymentAmount, (1_000e6)));
        else if (i == 5) (caller, data) = (pauser, abi.encodeCall(mgr.setMaxPaymentAmount, (1_000e6)));
        else if (i == 6) (caller, data) = (arbMgr, abi.encodeCall(mgr.unpause, ()));
        else if (i == 7) (caller, data) = (outsider, abi.encodeCall(mgr.grantRole, (mgr.DEFAULT_ADMIN_ROLE(), outsider)));
        else if (i == 8) (caller, data) = (outsider, abi.encodeCall(mgr.grantRole, (mgr.CONFIG_ROLE(), outsider)));
        else if (i == 9) (caller, data) = (admin, abi.encodeCall(mgr.renounceRole, (mgr.DEFAULT_ADMIN_ROLE(), admin)));
        else if (i == 10) (caller, data) = (outsider, abi.encodeCall(mgr.beginDefaultAdminTransfer, (outsider)));
        else if (i == 11) (caller, data) = (configMgr, abi.encodeCall(mgr.grantRole, (mgr.PAUSER_ROLE(), configMgr)));
        else if (i == 12) (caller, data) = (merchants[0], abi.encodeCall(mgr.pause, ()));
        else (caller, data) = (configMgr, abi.encodeCall(mgr.setMaxPaymentAmount, (mgr.HARD_MAX_AMOUNT() + 1)));
        vm.prank(caller);
        (bool success,) = address(mgr).call(data);
        if (success) vMisuse = true;
        ok[OK_MISUSE]++;
    }

    /// @dev Non-party callers (strangers, the other customers / merchants, role holders) try every party-only call.
    function strangerMisuse(uint256 seed, uint256 op) external act(true) {
        if (subs.length == 0) return;
        SubG memory g = subs[seed % subs.length];
        address pm = planMerchant[g.planKey];
        uint256 k = op % 7;
        address caller = _unauth((seed >> 8) % actors.length, k, g.customer, pm);
        bytes memory data;
        if (k == 0) data = abi.encodeCall(mgr.cancelSubscription, (g.key));
        else if (k == 1) data = abi.encodeCall(mgr.revokeMandate, (g.key));
        else if (k == 2) data = abi.encodeCall(mgr.createMandate, (g.key, g.amount, g.amount * 2, uint40(block.timestamp + 30 days)));
        else if (k == 3) data = abi.encodeCall(mgr.renew, (g.key));
        else if (k == 4) data = abi.encodeCall(mgr.setPlanActive, (g.planKey, false));
        else if (k == 5) data = abi.encodeCall(mgr.setPlanPayout, (g.planKey, caller));
        else data = abi.encodeCall(mgr.setPlanActive, (g.planKey, true));
        vm.prank(caller);
        (bool success,) = address(mgr).call(data);
        if (success) vMisuse = true;
        ok[OK_STRANGER]++;
    }

    function _unauth(uint256 start, uint256 k, address c, address pm) internal view returns (address) {
        uint256 n = actors.length;
        for (uint256 j; j < n; ++j) {
            address a = actors[(start + j) % n];
            bool authorized = k == 0 ? (a == c || a == pm) : (k >= 4 ? a == pm : a == c);
            if (!authorized) return a;
        }
        return outsider;
    }
}
