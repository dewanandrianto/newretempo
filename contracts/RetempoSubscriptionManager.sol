// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IRetempoEscrow} from "./interfaces/IRetempoEscrow.sol";
import {ZeroAddress, Unauthorized, InvalidReference, InvalidAmount, InvalidParameter, DepositMismatch, AdminRenounceDisabled, AmountOutOfBounds} from "./interfaces/RetempoErrors.sol";

/// @title RetempoSubscriptionManager
/// @notice Non-upgradeable fixed-price USDC subscriptions and finite recurring mandates.
/// @dev No sweep, payout override, subscription override or native-value entry point exists.
contract RetempoSubscriptionManager is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant MAX_PAYMENT_AMOUNT_KEY = keccak256("maxPaymentAmount");
    uint256 public constant HARD_MAX_AMOUNT = 1e15;
    uint128 public constant MIN_PAYMENT = 10_000;
    uint32 public constant MAX_MANDATE_DURATION = 366 days;
    uint32 public constant MIN_INTERVAL = 1 days;
    uint32 public constant MAX_INTERVAL = 366 days;

    enum SubStatus { None, Active, Canceled }
    enum PaymentTrigger { Manual, Recurring }
    /// @notice First failure in design section 4 order; zero means all listed checks passed.
    /// @dev Codes: 1 inactive/missing subscription; 2 missing plan; 3 payment limit;
    /// 4 arbitrator acceptance; 5 not due; 6 missing mandate; 7 inactive mandate;
    /// 8 expired mandate; 9 per-charge cap; 10 cumulative cap; 11 allowance; 12 balance.
    /// Code 13 checks accepted escrow windows after arbitrator acceptance and before due time.
    /// Pause state and downstream escrow/token execution are not simulated by these codes.
    enum ChargeReason {
        Ok, SubscriptionInactive, PlanMissing, PaymentLimitExceeded, ArbitratorNotAccepted,
        NotDue, MandateMissing, MandateInactive, MandateExpired, PerChargeCapExceeded,
        TotalCapExceeded, InsufficientAllowance, InsufficientBalance, EscrowTermsNotAccepted
    }

    struct Plan {
        address merchant;
        address payout;
        uint128 amount;
        uint32 interval;
        uint32 trial;
        uint32 grace;
        uint32 vestDuration;
        address arbitrator;
        bool customerMayRefundUnvested;
        bool active;
    }
    struct Subscription {
        address customer;
        bytes32 planKey;
        uint128 amount;
        uint32 interval;
        uint32 grace;
        uint40 nextChargeAt;
        uint32 chargeCount;
        address acceptedArbitrator;
        SubStatus status;
    }
    struct Mandate {
        uint128 perChargeCap;
        uint128 totalCap;
        uint128 spent;
        uint40 expiry;
        uint32 nonce;
        bool active;
    }

    IERC20 public immutable usdc;
    IRetempoEscrow public immutable escrow;
    mapping(bytes32 => Plan) private plans;
    mapping(bytes32 => Subscription) private subscriptions;
    mapping(bytes32 => Mandate) private mandates;
    uint256 public maxPaymentAmount = 10_000e6;

    struct EscrowTerms {
        uint32 responseWindow;
        uint32 resolutionTimeout;
    }
    // Separate storage preserves existing subscription and mandate layouts.
    mapping(bytes32 => EscrowTerms) public acceptedEscrowTerms;

    /// @dev Current escrow windows differ from the customer acceptance.
    error EscrowTermsNotAccepted();

    /// @dev The linked escrow does not designate this manager.
    error ManagerLinkMismatch();
    /// @dev The linked escrow uses a different settlement token.
    error TokenLinkMismatch();
    /// @dev A plan already exists for the merchant/reference key.
    error PlanExists();
    /// @dev The referenced plan does not exist.
    error PlanMissing();
    /// @dev The plan does not accept new subscriptions.
    error PlanInactive();
    /// @dev The billing interval is outside the permitted range.
    error InvalidInterval();
    /// @dev The trial exceeds the permitted duration.
    error InvalidTrial();
    /// @dev The grace period must be shorter than the billing interval.
    error InvalidGrace();
    /// @dev The nonzero vesting duration is outside the permitted range.
    error InvalidVestDuration();
    /// @dev The proposed arbitrator is zero or is the merchant.
    error InvalidArbitrator();
    /// @dev A subscription already exists for the customer/reference key.
    error SubscriptionExists();
    /// @dev The subscription is missing or inactive.
    error SubscriptionInactive();
    /// @dev The payment amount exceeds the current global ceiling.
    error PaymentLimitExceeded(uint256 amount, uint256 max);
    /// @dev The customer has not accepted the plan's required arbitrator.
    error ArbitratorNotAccepted();
    /// @dev The next subscription payment is not yet due.
    error NotDue();
    /// @dev No recurring mandate has been created.
    error MandateMissing();
    /// @dev The recurring mandate is inactive.
    error MandateInactive();
    /// @dev The recurring mandate has reached its exclusive expiry.
    error MandateExpired();
    /// @dev The payment exceeds the mandate's per-charge cap.
    error PerChargeCapExceeded();
    /// @dev The payment would exceed the mandate's cumulative cap.
    error TotalCapExceeded();
    /// @dev The customer's token allowance is below the required payment.
    error InsufficientAllowance(address customer, uint256 required, uint256 available);
    /// @dev The customer's token balance is below the required payment.
    error InsufficientBalance(address customer, uint256 required, uint256 available);
    /// @dev The mandate caps do not satisfy the subscription and hard-limit constraints.
    error InvalidMandateCaps();
    /// @dev The mandate expiry is not within the permitted future interval.
    error InvalidExpiry();
    /// @dev The escrow retained a nonzero manager token allowance after funding.
    error ResidualEscrowAllowance();
    /// @dev Escrow funding changed the manager's pre-existing token balance.
    error ManagerBalanceChanged();
    /// @dev The escrow returned a key different from the expected routed key.
    error UnexpectedEscrowKey();

    struct PaymentContext {
        address customer;
        uint256 amount;
        uint256 maximum;
        uint256 available;
    }

    /// @notice Records a merchant's immutable price and billing/escrow terms.
    /// @param planKey Plan identifier.
    /// @param merchant Plan owner.
    /// @param externalRef Merchant reference.
    /// @param payout Direct-payment recipient.
    /// @param amount Price in base units.
    /// @param interval Billing seconds.
    /// @param trial Trial seconds.
    /// @param grace Rebase grace seconds.
    /// @param vestDuration Escrow seconds or zero.
    /// @param arbitrator Escrow arbitrator.
    /// @param refundable Customer unvested-refund permission.
    event PlanCreated(bytes32 indexed planKey, address indexed merchant, bytes32 indexed externalRef, address payout, uint128 amount, uint32 interval, uint32 trial, uint32 grace, uint32 vestDuration, address arbitrator, bool refundable);
    /// @notice Records merchant-controlled activation or direct payout changes.
    /// @param planKey Plan identifier.
    /// @param active Whether new subscriptions are allowed.
    /// @param payout Current direct-payment recipient.
    event PlanUpdated(bytes32 indexed planKey, bool active, address payout);
    /// @notice Records a customer's subscription and explicit arbitrator acceptance.
    /// @param subKey Subscription key.
    /// @param planKey Plan key.
    /// @param customer Subscriber.
    /// @param externalRef Customer reference.
    /// @param amount Price snapshot.
    /// @param interval Interval snapshot.
    /// @param nextChargeAt Initial due timestamp before any immediate first payment.
    /// @param acceptedArbitrator Explicitly accepted arbitrator, zero for direct plans.
    event SubscriptionCreated(bytes32 indexed subKey, bytes32 indexed planKey, address indexed customer, bytes32 externalRef, uint128 amount, uint32 interval, uint40 nextChargeAt, address acceptedArbitrator);
    /// @notice Records one payment period before token interactions; reverted transfers remove the event.
    /// @param subKey Subscription key.
    /// @param planKey Plan key.
    /// @param customer Customer.
    /// @param chargeNumber One-based shared payment counter.
    /// @param merchant Merchant party.
    /// @param amount Price.
    /// @param trigger Manual=0, recurring=1.
    /// @param escrowKey Routed escrow key, zero for direct.
    /// @param periodStart Prior due timestamp or current time on rebase/first payment.
    /// @param nextChargeAt New due timestamp.
    /// @param rebased Whether lapse caused cadence rebase.
    event SubscriptionPaymentProcessed(bytes32 indexed subKey, bytes32 indexed planKey, address indexed customer, uint32 chargeNumber, address merchant, uint128 amount, PaymentTrigger trigger, bytes32 escrowKey, uint40 periodStart, uint40 nextChargeAt, bool rebased);
    /// @notice Records cancellation without refunding the current paid period.
    /// @param subKey Subscription key.
    /// @param customer Customer.
    /// @param by Customer or merchant caller.
    event SubscriptionCanceled(bytes32 indexed subKey, address indexed customer, address by);
    /// @notice Records a finite mandate, resetting spent and incrementing its generation nonce.
    /// @param subKey Subscription key.
    /// @param customer Authorizing customer.
    /// @param nonce Mandate generation.
    /// @param perChargeCap Per-payment cap.
    /// @param totalCap Cumulative recurring cap.
    /// @param expiry Exclusive expiry timestamp.
    event MandateCreated(bytes32 indexed subKey, address indexed customer, uint32 nonce, uint128 perChargeCap, uint128 totalCap, uint40 expiry);
    /// @notice Records deactivation of an active mandate.
    /// @param subKey Subscription key.
    /// @param customer Customer.
    /// @param nonce Deactivated generation.
    /// @param reason Customer=0, cancellation=1, replacement=2, changed escrow consent=3.
    event MandateRevoked(bytes32 indexed subKey, address indexed customer, uint32 nonce, uint8 reason);
    /// @notice Records the bounded global new-payment ceiling.
    /// @param key Parameter identifier.
    /// @param oldValue Old ceiling.
    /// @param newValue New ceiling.
    event ParameterUpdated(bytes32 indexed key, uint256 oldValue, uint256 newValue);

    /// @notice Constructs a paused manager and verifies fail-closed escrow/token linkage.
    /// @param usdc_ Six-decimal USDC token.
    /// @param escrow_ Escrow whose manager is this predicted address.
    /// @param admin Default admin.
    /// @param adminDelay Default-admin transfer delay.
    /// @param pauser Separate pause guardian.
    /// @param configManager Payment-limit configuration holder.
    constructor(address usdc_, address escrow_, address admin, uint48 adminDelay, address pauser, address configManager)
        AccessControlDefaultAdminRules(adminDelay, admin)
    {
        if (usdc_ == address(0) || escrow_ == address(0) || admin == address(0) || pauser == address(0) || configManager == address(0)) revert ZeroAddress();
        if (pauser == admin) revert InvalidParameter();
        IRetempoEscrow linkedEscrow = IRetempoEscrow(escrow_);
        if (linkedEscrow.manager() != address(this)) revert ManagerLinkMismatch();
        if (address(linkedEscrow.usdc()) != usdc_) revert TokenLinkMismatch();
        usdc = IERC20(usdc_);
        escrow = linkedEscrow;
        _grantRole(CONFIG_ROLE, configManager);
        _grantRole(PAUSER_ROLE, pauser);
        _pause();
    }

    /// @notice Publishes fixed billing terms; independent arbitrator checks occur at escrow funding.
    /// @param externalRef Nonzero merchant reference.
    /// @param payout Nonzero direct-payment recipient.
    /// @param amount USDC price.
    /// @param interval Billing seconds in [1 day,366 days].
    /// @param trial Trial seconds, at most 365 days.
    /// @param grace Rebase grace strictly below interval.
    /// @param vestDuration Zero for direct, or [1 hour,90 days].
    /// @param arbitrator Nonzero nonmerchant for escrow plans.
    /// @param refundable Escrow customer unvested-refund permission.
    /// @return key Deterministic plan key.
    function createPlan(bytes32 externalRef, address payout, uint128 amount, uint32 interval, uint32 trial, uint32 grace, uint32 vestDuration, address arbitrator, bool refundable) external whenNotPaused returns (bytes32 key) {
        if (externalRef == bytes32(0)) revert InvalidReference();
        if (payout == address(0)) revert ZeroAddress();
        uint256 maximum = maxPaymentAmount;
        if (amount < MIN_PAYMENT || amount > maximum) revert AmountOutOfBounds(amount, MIN_PAYMENT, maximum);
        if (interval < MIN_INTERVAL || interval > MAX_INTERVAL) revert InvalidInterval();
        if (trial > 365 days) revert InvalidTrial();
        if (grace >= interval) revert InvalidGrace();
        if (vestDuration != 0) {
            if (vestDuration < 1 hours || vestDuration > 90 days) revert InvalidVestDuration();
            if (arbitrator == address(0) || arbitrator == msg.sender) revert InvalidArbitrator();
        }
        key = planKey(msg.sender, externalRef);
        Plan storage p = plans[key];
        if (p.merchant != address(0)) revert PlanExists();
        p.merchant = msg.sender;
        p.payout = payout;
        p.amount = amount;
        p.interval = interval;
        p.trial = trial;
        p.grace = grace;
        p.vestDuration = vestDuration;
        p.arbitrator = arbitrator;
        p.customerMayRefundUnvested = refundable;
        p.active = true;
        _emitPlanCreated(key, externalRef, p);
    }

    /// @notice Lets the merchant block new subscriptions without affecting existing billing.
    /// @param key Plan key.
    /// @param active New flag; activation is prohibited while paused.
    function setPlanActive(bytes32 key, bool active) external {
        Plan storage p = _merchantPlan(key);
        if (active) _requireNotPaused();
        p.active = active;
        emit PlanUpdated(key, active, p.payout);
    }

    /// @notice Lets only the merchant update its direct-payment recipient, even while paused.
    /// @param key Plan key.
    /// @param payout New nonzero direct-payment recipient.
    function setPlanPayout(bytes32 key, address payout) external {
        Plan storage p = _merchantPlan(key);
        if (payout == address(0)) revert ZeroAddress();
        p.payout = payout;
        emit PlanUpdated(key, p.active, payout);
    }

    /// @notice Subscribes with explicit arbitrator acceptance; trial-free plans pay immediately.
    /// @param externalRef Nonzero customer reference.
    /// @param planKey_ Active plan key.
    /// @param acceptedArbitrator Plan arbitrator for escrow plans, zero for direct plans.
    /// @return subKey Deterministic subscription key.
    function subscribe(bytes32 externalRef, bytes32 planKey_, address acceptedArbitrator) external whenNotPaused nonReentrant returns (bytes32 subKey) {
        if (externalRef == bytes32(0)) revert InvalidReference();
        Plan storage p = plans[planKey_];
        if (p.merchant == address(0)) revert PlanMissing();
        if (!p.active) revert PlanInactive();
        if (p.merchant == msg.sender) revert Unauthorized();
        uint256 maximum = maxPaymentAmount;
        if (p.amount > maximum) revert PaymentLimitExceeded(p.amount, maximum);
        if (acceptedArbitrator != (p.vestDuration == 0 ? address(0) : p.arbitrator)) revert ArbitratorNotAccepted();
        subKey = subscriptionKey(msg.sender, externalRef);
        Subscription storage s = subscriptions[subKey];
        if (s.status != SubStatus.None) revert SubscriptionExists();
        s.customer = msg.sender;
        s.planKey = planKey_;
        s.amount = p.amount;
        s.interval = p.interval;
        s.grace = p.grace;
        s.nextChargeAt = uint40(block.timestamp + p.trial);
        s.acceptedArbitrator = acceptedArbitrator;
        s.status = SubStatus.Active;
        if (p.vestDuration != 0) {
            uint32 response = escrow.responseWindow();
            uint32 resolution = escrow.resolutionTimeout();
            acceptedEscrowTerms[subKey] = EscrowTerms(response, resolution);
            emit EscrowTermsAccepted(subKey, msg.sender, response, resolution);
        }
        emit SubscriptionCreated(subKey, planKey_, msg.sender, externalRef, s.amount, s.interval, s.nextChargeAt, acceptedArbitrator);
        if (p.trial == 0) _executePayment(subKey, PaymentTrigger.Manual);
    }

    /// @notice Records accepted dispute windows for an escrow subscription.
    event EscrowTermsAccepted(bytes32 indexed subKey, address indexed customer, uint32 responseWindow, uint32 resolutionTimeout);

    /// @notice Explicitly accepts current dispute windows without creating a recurring mandate.
    /// @param subKey Active escrow subscription key.
    /// @param expectedResponseWindow Response seconds the customer reviewed.
    /// @param expectedResolutionTimeout Resolution seconds the customer reviewed.
    function acceptEscrowTerms(bytes32 subKey, uint32 expectedResponseWindow, uint32 expectedResolutionTimeout) external whenNotPaused {
        Subscription storage s = subscriptions[subKey];
        if (s.customer != msg.sender) revert Unauthorized();
        if (s.status != SubStatus.Active) revert SubscriptionInactive();
        if (plans[s.planKey].vestDuration == 0) revert InvalidParameter();
        if (expectedResponseWindow != escrow.responseWindow() || expectedResolutionTimeout != escrow.resolutionTimeout()) revert EscrowTermsNotAccepted();
        EscrowTerms storage terms = acceptedEscrowTerms[subKey];
        if (terms.responseWindow != expectedResponseWindow || terms.resolutionTimeout != expectedResolutionTimeout) {
            Mandate storage m = mandates[subKey];
            if (m.active) _deactivateMandate(subKey, s.customer, m, 3);
            terms.responseWindow = expectedResponseWindow;
            terms.resolutionTimeout = expectedResolutionTimeout;
        }
        emit EscrowTermsAccepted(subKey, s.customer, expectedResponseWindow, expectedResolutionTimeout);
    }

    /// @notice Pays one due period as the customer, without consuming any mandate cap.
    /// @param subKey Active subscription key.
    function renew(bytes32 subKey) external whenNotPaused nonReentrant {
        if (subscriptions[subKey].customer != msg.sender) revert Unauthorized();
        _executePayment(subKey, PaymentTrigger.Manual);
    }

    /// @notice Permissionlessly executes one due period under the customer's active mandate.
    /// @param subKey Subscription key.
    function charge(bytes32 subKey) external whenNotPaused nonReentrant {
        _executePayment(subKey, PaymentTrigger.Recurring);
    }

    /// @notice Creates/replaces a finite mandate, incrementing nonce and resetting recurring spent.
    /// @param subKey Active subscription key.
    /// @param perChargeCap At least the subscription price.
    /// @param totalCap At least perChargeCap and at most HARD_MAX_AMOUNT.
    /// @param expiry Future exclusive expiry, at most MAX_MANDATE_DURATION away.
    function createMandate(bytes32 subKey, uint128 perChargeCap, uint128 totalCap, uint40 expiry) external whenNotPaused {
        Subscription storage s = subscriptions[subKey];
        if (msg.sender != s.customer) revert Unauthorized();
        if (s.status != SubStatus.Active) revert SubscriptionInactive();
        if (perChargeCap < s.amount || totalCap < perChargeCap || totalCap > HARD_MAX_AMOUNT) revert InvalidMandateCaps();
        if (expiry <= block.timestamp || uint256(expiry) > block.timestamp + MAX_MANDATE_DURATION) revert InvalidExpiry();
        Mandate storage m = mandates[subKey];
        if (m.active) _deactivateMandate(subKey, s.customer, m, 2);
        m.nonce += 1;
        m.perChargeCap = perChargeCap;
        m.totalCap = totalCap;
        m.spent = 0;
        m.expiry = expiry;
        m.active = true;
        emit MandateCreated(subKey, s.customer, m.nonce, perChargeCap, totalCap, expiry);
    }

    /// @notice Immediately deactivates the caller's active mandate, including while paused.
    /// @param subKey Subscription key.
    function revokeMandate(bytes32 subKey) external {
        Subscription storage s = subscriptions[subKey];
        if (s.customer != msg.sender) revert Unauthorized();
        Mandate storage m = mandates[subKey];
        if (!m.active) revert MandateInactive();
        _deactivateMandate(subKey, s.customer, m, 0);
    }

    /// @notice Allows the customer or merchant to cancel and revoke an active mandate while paused.
    /// @param subKey Active subscription; the current paid period is not refunded.
    function cancelSubscription(bytes32 subKey) external {
        Subscription storage s = subscriptions[subKey];
        if (s.status != SubStatus.Active) revert SubscriptionInactive();
        if (msg.sender != s.customer && msg.sender != plans[s.planKey].merchant) revert Unauthorized();
        s.status = SubStatus.Canceled;
        Mandate storage m = mandates[subKey];
        if (m.active) _deactivateMandate(subKey, s.customer, m, 1);
        emit SubscriptionCanceled(subKey, s.customer, msg.sender);
    }

    /// @notice Renounces non-admin roles using OpenZeppelin's standard checks; default-admin renunciation is disabled.
    /// @dev Changing the default admin requires beginDefaultAdminTransfer to a nonzero successor and delayed acceptDefaultAdminTransfer.
    /// @param role Role to renounce; DEFAULT_ADMIN_ROLE always reverts.
    /// @param callerConfirmation Must equal the caller for non-admin roles.
    function renounceRole(bytes32 role, address callerConfirmation) public override {
        if (role == DEFAULT_ADMIN_ROLE) revert AdminRenounceDisabled();
        super.renounceRole(role, callerConfirmation);
    }

    /// @notice Pauses new plans, activation, subscriptions, payments and mandate creation.
    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    /// @notice Resumes operations; only the default admin may unpause.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
    /// @notice Changes only the ceiling checked for new plans, subscriptions and payments.
    /// @param value Ceiling in [MIN_PAYMENT,HARD_MAX_AMOUNT]; existing prices are unchanged.
    function setMaxPaymentAmount(uint256 value) external onlyRole(CONFIG_ROLE) {
        if (value < MIN_PAYMENT || value > HARD_MAX_AMOUNT) revert InvalidParameter();
        emit ParameterUpdated(MAX_PAYMENT_AMOUNT_KEY, maxPaymentAmount, value);
        maxPaymentAmount = value;
    }

    /// @notice Evaluates section 4 recurring checks in their documented order.
    /// @dev Does not simulate pause guards, token transfers or downstream escrow restrictions.
    /// @param subKey Subscription key.
    /// @return ok Whether listed checks pass.
    /// @return reason First failure, encoded as ChargeReason.
    function canCharge(bytes32 subKey) external view returns (bool ok, uint8 reason) {
        PaymentContext memory context;
        ChargeReason result = _paymentReason(subKey, PaymentTrigger.Recurring, context);
        return (result == ChargeReason.Ok, uint8(result));
    }
    /// @notice Returns the plan, or zero state if missing.
    /// @param key Plan key.
    /// @return value Stored plan.
    function getPlan(bytes32 key) external view returns (Plan memory value) { return plans[key]; }
    /// @notice Returns the subscription, or zero state if missing.
    /// @param key Subscription key.
    /// @return value Stored subscription.
    function getSubscription(bytes32 key) external view returns (Subscription memory value) { return subscriptions[key]; }
    /// @notice Returns the current mandate generation, including its spent amount.
    /// @param subKey Subscription key.
    /// @return value Stored mandate.
    function getMandate(bytes32 subKey) external view returns (Mandate memory value) { return mandates[subKey]; }
    /// @notice Computes a merchant-scoped plan identifier.
    /// @param merchant Merchant address.
    /// @param externalRef Merchant reference.
    /// @return key Deterministic plan key.
    function planKey(address merchant, bytes32 externalRef) public pure returns (bytes32 key) { return keccak256(abi.encode(merchant, externalRef)); }
    /// @notice Computes a customer-scoped subscription identifier.
    /// @param customer Customer address.
    /// @param externalRef Customer reference.
    /// @return key Deterministic subscription key.
    function subscriptionKey(address customer, bytes32 externalRef) public pure returns (bytes32 key) { return keccak256(abi.encode(customer, externalRef)); }

    function _merchantPlan(bytes32 key) private view returns (Plan storage p) {
        p = plans[key];
        if (p.merchant == address(0)) revert PlanMissing();
        if (p.merchant != msg.sender) revert Unauthorized();
    }
    function _emitPlanCreated(bytes32 key, bytes32 externalRef, Plan storage p) private {
        emit PlanCreated(key, p.merchant, externalRef, p.payout, p.amount, p.interval, p.trial, p.grace, p.vestDuration, p.arbitrator, p.customerMayRefundUnvested);
    }
    function _deactivateMandate(bytes32 subKey, address customer, Mandate storage m, uint8 reason) private {
        m.active = false;
        emit MandateRevoked(subKey, customer, m.nonce, reason);
    }

    function _paymentReason(bytes32 subKey, PaymentTrigger trigger, PaymentContext memory context) private view returns (ChargeReason) {
        Subscription storage s = subscriptions[subKey];
        if (s.status != SubStatus.Active) return ChargeReason.SubscriptionInactive;
        Plan storage p = plans[s.planKey];
        if (p.merchant == address(0)) return ChargeReason.PlanMissing;
        uint256 amount = s.amount;
        context.amount = amount;
        context.maximum = maxPaymentAmount;
        if (amount > context.maximum) return ChargeReason.PaymentLimitExceeded;
        if (s.acceptedArbitrator != (p.vestDuration == 0 ? address(0) : p.arbitrator)) return ChargeReason.ArbitratorNotAccepted;
        if (p.vestDuration != 0) {
            EscrowTerms storage terms = acceptedEscrowTerms[subKey];
            if (terms.responseWindow != escrow.responseWindow() || terms.resolutionTimeout != escrow.resolutionTimeout()) {
                return ChargeReason.EscrowTermsNotAccepted;
            }
        }
        if (block.timestamp < s.nextChargeAt) return ChargeReason.NotDue;
        if (trigger == PaymentTrigger.Recurring) {
            Mandate storage m = mandates[subKey];
            if (m.nonce == 0) return ChargeReason.MandateMissing;
            if (!m.active) return ChargeReason.MandateInactive;
            if (block.timestamp >= m.expiry) return ChargeReason.MandateExpired;
            if (amount > m.perChargeCap) return ChargeReason.PerChargeCapExceeded;
            if (uint256(m.spent) + amount > m.totalCap) return ChargeReason.TotalCapExceeded;
        }
        context.customer = s.customer;
        context.available = usdc.allowance(context.customer, address(this));
        if (context.available < amount) return ChargeReason.InsufficientAllowance;
        context.available = usdc.balanceOf(context.customer);
        if (context.available < amount) return ChargeReason.InsufficientBalance;
        return ChargeReason.Ok;
    }

    function _revertReason(ChargeReason reason, PaymentContext memory context) private pure {
        if (reason == ChargeReason.SubscriptionInactive) revert SubscriptionInactive();
        if (reason == ChargeReason.PlanMissing) revert PlanMissing();
        if (reason == ChargeReason.PaymentLimitExceeded) revert PaymentLimitExceeded(context.amount, context.maximum);
        if (reason == ChargeReason.ArbitratorNotAccepted) revert ArbitratorNotAccepted();
        if (reason == ChargeReason.EscrowTermsNotAccepted) revert EscrowTermsNotAccepted();
        if (reason == ChargeReason.NotDue) revert NotDue();
        if (reason == ChargeReason.MandateMissing) revert MandateMissing();
        if (reason == ChargeReason.MandateInactive) revert MandateInactive();
        if (reason == ChargeReason.MandateExpired) revert MandateExpired();
        if (reason == ChargeReason.PerChargeCapExceeded) revert PerChargeCapExceeded();
        if (reason == ChargeReason.TotalCapExceeded) revert TotalCapExceeded();
        if (reason == ChargeReason.InsufficientAllowance) revert InsufficientAllowance(context.customer, context.amount, context.available);
        if (reason == ChargeReason.InsufficientBalance) revert InsufficientBalance(context.customer, context.amount, context.available);
    }

    function _executePayment(bytes32 subKey, PaymentTrigger trigger) private {
        PaymentContext memory context;
        ChargeReason reason = _paymentReason(subKey, trigger, context);
        _revertReason(reason, context);
        Subscription storage s = subscriptions[subKey];
        Plan storage p = plans[s.planKey];
        uint40 previousDue = s.nextChargeAt;
        bool rebased = block.timestamp > uint256(previousDue) + s.grace;
        uint40 periodStart = rebased ? uint40(block.timestamp) : previousDue;
        s.nextChargeAt = uint40(uint256(periodStart) + s.interval);
        s.chargeCount += 1;
        if (trigger == PaymentTrigger.Recurring) mandates[subKey].spent += s.amount;
        bytes32 invoiceRef;
        bytes32 routedKey;
        if (p.vestDuration != 0) {
            invoiceRef = keccak256(abi.encode(subKey, s.chargeCount));
            routedKey = keccak256(abi.encode(p.merchant, invoiceRef));
        }
        _emitPayment(subKey, s, p, trigger, routedKey, periodStart, rebased);
        if (p.vestDuration == 0) {
            usdc.safeTransferFrom(s.customer, p.payout, s.amount);
        } else {
            _fundEscrow(invoiceRef, routedKey, s, p);
        }
    }

    function _emitPayment(bytes32 subKey, Subscription storage s, Plan storage p, PaymentTrigger trigger, bytes32 routedKey, uint40 periodStart, bool rebased) private {
        emit SubscriptionPaymentProcessed(subKey, s.planKey, s.customer, s.chargeCount, p.merchant, s.amount, trigger, routedKey, periodStart, s.nextChargeAt, rebased);
    }

    function _fundEscrow(bytes32 invoiceRef, bytes32 routedKey, Subscription storage s, Plan storage p) private {
        uint128 amount = s.amount;
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(s.customer, address(this), amount);
        uint256 afterBalance = usdc.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert DepositMismatch(amount, beforeBalance, afterBalance);
        usdc.forceApprove(address(escrow), amount);
        bytes32 actualKey = escrow.fundFromManager(invoiceRef, p.merchant, s.customer, amount, p.vestDuration, p.arbitrator, p.customerMayRefundUnvested);
        if (actualKey != routedKey) revert UnexpectedEscrowKey();
        if (usdc.allowance(address(this), address(escrow)) != 0) revert ResidualEscrowAllowance();
        if (usdc.balanceOf(address(this)) != beforeBalance) revert ManagerBalanceChanged();
    }
}
