// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {ZeroAddress, Unauthorized, InvalidReference, InvalidAmount, InvalidParameter, DepositMismatch, AdminRenounceDisabled, AmountOutOfBounds} from "./interfaces/RetempoErrors.sol";

/// @title RetempoEscrow
/// @notice Non-upgradeable USDC vesting escrow with pull credits and partial disputes.
/// @dev Only creation and funding pause. Forced token donations are not recoverable.
contract RetempoEscrow is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard, EIP712, Nonces {
    using SafeERC20 for IERC20;

    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant ARBITRATOR_MANAGER_ROLE = keccak256("ARBITRATOR_MANAGER_ROLE");
    bytes32 public constant MIN_AMOUNT_KEY = keccak256("minAmount");
    bytes32 public constant MAX_ESCROW_AMOUNT_KEY = keccak256("maxEscrowAmount");
    bytes32 public constant MAX_AGGREGATE_EXPOSURE_KEY = keccak256("maxAggregateExposure");
    bytes32 public constant RESPONSE_WINDOW_KEY = keccak256("responseWindow");
    bytes32 public constant RESOLUTION_TIMEOUT_KEY = keccak256("resolutionTimeout");
    bytes32 public constant SET_PAYOUT_ADDRESS_TYPEHASH = keccak256(
        "SetPayoutAddress(address account,address newPayout,uint256 nonce,uint256 deadline)"
    );
    uint32 public constant MIN_VEST_DURATION = 1 hours;
    uint32 public constant MAX_VEST_DURATION = 90 days;
    uint256 public constant HARD_MAX_AMOUNT = 1e15;
    uint32 public constant MIN_RESPONSE_WINDOW = 1 days;
    uint32 public constant MAX_RESPONSE_WINDOW = 30 days;
    uint32 public constant MIN_RESOLUTION_TIMEOUT = 7 days;
    uint32 public constant MAX_RESOLUTION_TIMEOUT = 90 days;

    enum Status { None, Pending, Active, Closed, Cancelled }
    enum DisputeState { None, Open, Resolved }
    enum Outcome { None, FullyVested, Refunded, Resolved, Expired, Settled }

    struct Escrow {
        address merchant;
        address customer;
        address arbitrator;
        uint128 amount;
        uint128 claimed;
        uint128 awarded;
        uint128 refunded;
        uint128 frozen;
        uint128 carvedVested;
        uint40 vestStart;
        uint32 vestDuration;
        uint32 responseWindow;
        uint32 resolutionTimeout;
        uint40 disputedAt;
        bool customerMayRefundUnvested;
        bool merchantResponded;
        Status status;
        DisputeState dispute;
        Outcome outcome;
        uint32 settlementId;
        address settlementProposer;
        uint128 settlementMerchantAmount;
        uint128 settlementScope;
        address replacementProposer;
        address replacementCandidate;
    }

    IERC20 public immutable usdc;
    address public immutable manager;
    mapping(bytes32 => Escrow) private escrows;
    mapping(address => uint256) private withdrawable;
    mapping(address => address) public payoutAddress;
    mapping(address => bool) private arbitrators;
    uint256 public totalLocked;
    uint256 public totalWithdrawable;
    uint256 public minAmount = 10_000;
    uint256 public maxEscrowAmount = 10_000e6;
    uint256 public maxAggregateExposure;
    uint32 public responseWindow = 7 days;
    uint32 public resolutionTimeout = 30 days;

    /// @dev An escrow already exists for the merchant/reference key.
    error EscrowExists();
    /// @dev The escrow status does not permit this operation.
    error InvalidStatus();
    /// @dev The vesting duration is outside the permitted range.
    error InvalidDuration();
    /// @dev The arbitrator conflicts with a party or privileged role.
    error ConflictedArbitrator();
    /// @dev The arbitrator is not allowlisted.
    error ArbitratorNotAllowed();
    /// @dev The accepted arbitrator differs from the escrow's arbitrator.
    error ArbitratorMismatch();
    /// @dev The supplied funding commitment differs from the escrow terms.
    error TermsMismatch();
    /// @dev Funding would exceed the aggregate liability limit.
    error ExposureExceeded(uint256 currentExposure, uint256 deposit, uint256 limit);
    /// @dev The requested allocation exceeds its available balance or scope.
    error AmountTooLarge(uint256 requested, uint256 maximum);
    /// @dev The beneficiary has no credit available for withdrawal.
    error NothingToWithdraw();
    /// @dev The escrow terms prohibit customer refunds of unvested funds.
    error RefundNotAllowed();
    /// @dev The dispute state does not permit this operation.
    error InvalidDispute();
    /// @dev A required evidence commitment is zero.
    error InvalidEvidence();
    /// @dev The dispute response deadline has passed.
    error ResponseWindowEnded();
    /// @dev The merchant has already submitted its dispute response.
    error AlreadyResponded();
    /// @dev Resolution must wait for a response or the response deadline.
    error ResponseWindowOpen();
    /// @dev The dispute resolution timeout has not been reached.
    error TimeoutNotReached();
    /// @dev Arbitration authority ends at the snapshotted resolution deadline.
    error ResolutionWindowEnded();
    /// @dev The proposal, counterparty or expected identifier does not match.
    error ProposalMismatch();
    /// @dev The remaining balance scope differs from the settlement commitment.
    error SettlementScopeChanged();
    /// @dev The resolution timeout must be strictly longer than the response window.
    error InvalidWindowOrder();
    /// @dev The payout authorization deadline has passed.
    error SignatureExpired();
    /// @dev The payout authorization signature is invalid.
    error InvalidSignature();

    /// @notice Records immutable pending escrow terms; all amounts are USDC base units.
    /// @param escrowKey Merchant/invoice key.
    /// @param merchant Merchant party.
    /// @param customer Customer party.
    /// @param invoiceRef External invoice reference.
    /// @param amount Deposit.
    /// @param vestDuration Vesting seconds.
    /// @param arbitrator Proposed arbitrator.
    /// @param refundable Unvested-refund permission.
    /// @param responseWindow Snapshotted response seconds.
    /// @param resolutionTimeout Snapshotted timeout seconds.
    event EscrowCreated(bytes32 indexed escrowKey, address indexed merchant, address indexed customer, bytes32 invoiceRef, uint128 amount, uint32 vestDuration, address arbitrator, bool refundable, uint32 responseWindow, uint32 resolutionTimeout);
    /// @notice Records customer arbitrator acceptance.
    /// @param escrowKey Escrow key.
    /// @param customer Customer.
    /// @param arbitrator Accepted arbitrator.
    /// @param viaManager Whether acceptance came through a subscription.
    event ArbitratorAccepted(bytes32 indexed escrowKey, address indexed customer, address indexed arbitrator, bool viaManager);
    /// @notice Records the funded vesting period.
    /// @param escrowKey Escrow key.
    /// @param payer Token source.
    /// @param amount Deposit.
    /// @param vestStart Start timestamp.
    /// @param vestEnd End timestamp.
    /// @param viaManager Manager funding flag.
    event EscrowFunded(bytes32 indexed escrowKey, address indexed payer, uint128 amount, uint40 vestStart, uint40 vestEnd, bool viaManager);
    /// @notice Records cancellation of an unfunded escrow.
    /// @param escrowKey Cancelled escrow.
    event EscrowCancelled(bytes32 indexed escrowKey);
    /// @notice Records vesting credit, not an external token transfer.
    /// @param escrowKey Escrow key.
    /// @param merchant Beneficiary.
    /// @param amount Credit.
    /// @param totalClaimed Cumulative vesting claims.
    event VestedClaimed(bytes32 indexed escrowKey, address indexed merchant, uint128 amount, uint128 totalClaimed);
    /// @notice Records a customer refund credit; reason uses the Outcome enum encoding.
    /// @param escrowKey Escrow key.
    /// @param customer Beneficiary.
    /// @param amount Credit.
    /// @param reason Cause.
    /// @param totalRefunded Cumulative refunds.
    event RefundCredited(bytes32 indexed escrowKey, address indexed customer, uint128 amount, Outcome reason, uint128 totalRefunded);
    /// @notice Records a partial dispute and its immutable deadlines.
    /// @param escrowKey Escrow key.
    /// @param customer Customer.
    /// @param arbitrator Assigned arbitrator.
    /// @param amount Frozen balance.
    /// @param carvedVested Vested part carved out.
    /// @param reasonHash Evidence commitment.
    /// @param respondBy Response deadline.
    /// @param resolveBy Timeout timestamp.
    event DisputeOpened(bytes32 indexed escrowKey, address indexed customer, address indexed arbitrator, uint128 amount, uint128 carvedVested, bytes32 reasonHash, uint256 respondBy, uint256 resolveBy);
    /// @notice Records the merchant's single timely response.
    /// @param escrowKey Escrow key.
    /// @param merchant Merchant.
    /// @param responseHash Response commitment.
    event DisputeResponded(bytes32 indexed escrowKey, address indexed merchant, bytes32 responseHash);
    /// @notice Records an arbitrator's split of frozen funds.
    /// @param escrowKey Escrow key.
    /// @param arbitrator Ruling caller.
    /// @param merchantAmount Merchant credit.
    /// @param customerAmount Customer credit.
    /// @param rulingHash Ruling commitment.
    event DisputeResolved(bytes32 indexed escrowKey, address indexed arbitrator, uint128 merchantAmount, uint128 customerAmount, bytes32 rulingHash);
    /// @notice Records the deterministic timeout split.
    /// @param escrowKey Escrow key.
    /// @param caller Timeout caller.
    /// @param merchantAmount Merchant credit.
    /// @param customerAmount Customer credit.
    event DisputeExpired(bytes32 indexed escrowKey, address indexed caller, uint128 merchantAmount, uint128 customerAmount);
    /// @notice Records a replaceable settlement proposal committed to its balance scope.
    /// @param escrowKey Escrow key.
    /// @param proposer Proposing party.
    /// @param merchantAmount Proposed merchant credit.
    /// @param scope Frozen funds if positive, otherwise the entire remaining held balance; must be unchanged at acceptance.
    /// @param settlementId Monotonic proposal identifier.
    event SettlementProposed(bytes32 indexed escrowKey, address indexed proposer, uint128 merchantAmount, uint128 scope, uint32 settlementId);
    /// @notice Records mutual settlement of frozen funds or the entire remaining balance.
    /// @param escrowKey Escrow key.
    /// @param acceptor Other party.
    /// @param merchantAmount Merchant credit.
    /// @param customerAmount Customer credit.
    /// @param settlementId Accepted identifier.
    /// @param disputeScoped Whether only frozen funds were split.
    event SettlementAccepted(bytes32 indexed escrowKey, address indexed acceptor, uint128 merchantAmount, uint128 customerAmount, uint32 settlementId, bool disputeScoped);
    /// @notice Records one party's arbitrator replacement proposal.
    /// @param escrowKey Escrow key.
    /// @param proposer Party.
    /// @param candidate Proposed arbitrator.
    event ArbitratorReplacementProposed(bytes32 indexed escrowKey, address indexed proposer, address indexed candidate);
    /// @notice Records mutually accepted arbitrator replacement.
    /// @param escrowKey Escrow key.
    /// @param oldArbitrator Previous arbitrator.
    /// @param newArbitrator Accepted candidate.
    event ArbitratorReplaced(bytes32 indexed escrowKey, address indexed oldArbitrator, address indexed newArbitrator);
    /// @notice Records complete allocation of the deposit.
    /// @param escrowKey Closed escrow.
    /// @param outcome Last allocation cause.
    event EscrowClosed(bytes32 indexed escrowKey, Outcome outcome);
    /// @notice Records withdrawal of a beneficiary's full credit.
    /// @param account Credit owner.
    /// @param to Recipient.
    /// @param amount USDC transferred.
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    /// @notice Records a beneficiary-authorized payout update; zero resets to self.
    /// @param account Beneficiary.
    /// @param newPayout New stored address.
    /// @param nonce Consumed authorization nonce.
    event PayoutAddressUpdated(address indexed account, address indexed newPayout, uint256 nonce);
    /// @notice Records allowlisting.
    /// @param arbitrator Added arbitrator.
    event ArbitratorAdded(address indexed arbitrator);
    /// @notice Records removal from the allowlist.
    /// @param arbitrator Removed arbitrator.
    event ArbitratorRemoved(address indexed arbitrator);
    /// @notice Records a bounded configuration change for future creation/funding.
    /// @param key Parameter key.
    /// @param oldValue Previous value.
    /// @param newValue Updated value.
    event ParameterUpdated(bytes32 indexed key, uint256 oldValue, uint256 newValue);

    /// @notice Constructs a paused escrow with immutable USDC and manager linkage.
    /// @param usdc_ Six-decimal token.
    /// @param manager_ Predicted manager address.
    /// @param admin Default admin.
    /// @param adminDelay Default-admin transfer delay.
    /// @param pauser Separate pause guardian.
    /// @param configManager Configuration role holder.
    /// @param arbitratorManager Allowlist role holder.
    /// @param maxAggregateExposure_ Positive exposure ceiling.
    constructor(address usdc_, address manager_, address admin, uint48 adminDelay, address pauser, address configManager, address arbitratorManager, uint256 maxAggregateExposure_)
        AccessControlDefaultAdminRules(adminDelay, admin) EIP712("RetempoEscrow", "1")
    {
        if (usdc_ == address(0) || manager_ == address(0) || admin == address(0) || pauser == address(0) || configManager == address(0) || arbitratorManager == address(0)) revert ZeroAddress();
        if (pauser == admin || maxAggregateExposure_ == 0) revert InvalidParameter();
        if (resolutionTimeout <= responseWindow) revert InvalidWindowOrder();
        usdc = IERC20(usdc_);
        manager = manager_;
        maxAggregateExposure = maxAggregateExposure_;
        _grantRole(CONFIG_ROLE, configManager);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(ARBITRATOR_MANAGER_ROLE, arbitratorManager);
        _pause();
    }

    /// @notice Creates pending terms owned by the calling merchant.
    /// @param invoiceRef Unique nonzero reference.
    /// @param customer Customer party.
    /// @param amount Deposit.
    /// @param vestDuration Vesting seconds.
    /// @param proposedArbitrator Independent allowlisted arbitrator.
    /// @param refundable Unvested refund flag.
    /// @return key Deterministic escrow key.
    function createEscrow(bytes32 invoiceRef, address customer, uint128 amount, uint32 vestDuration, address proposedArbitrator, bool refundable) external whenNotPaused returns (bytes32 key) {
        return _create(invoiceRef, msg.sender, customer, amount, vestDuration, proposedArbitrator, refundable);
    }

    /// @notice Cancels only the merchant's still-pending escrow, including while paused.
    /// @param key Pending escrow key.
    function cancelUnfunded(bytes32 key) external {
        Escrow storage e = escrows[key];
        if (msg.sender != e.merchant) revert Unauthorized();
        if (e.status != Status.Pending) revert InvalidStatus();
        e.status = Status.Cancelled;
        emit EscrowCancelled(key);
    }

    /// @notice Accepts committed terms and funds a pending escrow as its customer.
    /// @param key Escrow key.
    /// @param acceptedArbitrator Expected arbitrator.
    /// @param termsHash_ Expected current terms hash.
    function fund(bytes32 key, address acceptedArbitrator, bytes32 termsHash_) external whenNotPaused nonReentrant {
        Escrow storage e = escrows[key];
        if (msg.sender != e.customer) revert Unauthorized();
        if (e.status != Status.Pending) revert InvalidStatus();
        if (acceptedArbitrator != e.arbitrator) revert ArbitratorMismatch();
        _checkArbitrator(e.arbitrator, e.merchant, e.customer);
        if (termsHash_ != termsHash(key)) revert TermsMismatch();
        _fund(key, e, msg.sender, false);
    }

    /// @notice Atomically creates and funds terms accepted through the immutable manager.
    /// @param invoiceRef Nonzero invoice reference.
    /// @param merchant Merchant.
    /// @param customer Customer.
    /// @param amount Deposit.
    /// @param vestDuration Vesting seconds.
    /// @param arbitrator Accepted arbitrator.
    /// @param refundable Unvested refund flag.
    /// @return key Funded escrow key.
    function fundFromManager(bytes32 invoiceRef, address merchant, address customer, uint128 amount, uint32 vestDuration, address arbitrator, bool refundable) external whenNotPaused nonReentrant returns (bytes32 key) {
        if (msg.sender != manager) revert Unauthorized();
        key = _create(invoiceRef, merchant, customer, amount, vestDuration, arbitrator, refundable);
        _fund(key, escrows[key], msg.sender, true);
    }

    /// @notice Credits all currently claimable vested funds to the merchant's pull ledger.
    /// @param key Active escrow key.
    function claim(bytes32 key) external {
        Escrow storage e = _active(key);
        if (msg.sender != e.merchant) revert Unauthorized();
        uint128 amount = uint128(_claimable(e));
        if (amount == 0) revert InvalidAmount();
        e.claimed += amount;
        _credit(e.merchant, amount);
        emit VestedClaimed(key, e.merchant, amount, e.claimed);
        _close(key, e, Outcome.FullyVested);
    }

    /// @notice Credits a merchant-authorized refund from unfrozen funds.
    /// @param key Active escrow.
    /// @param amount Positive amount no larger than its free balance.
    function merchantRefund(bytes32 key, uint128 amount) external {
        Escrow storage e = _active(key);
        if (msg.sender != e.merchant) revert Unauthorized();
        if (amount == 0 || amount > _balance(e) - e.frozen) revert InvalidAmount();
        _refund(key, e, amount, Outcome.Refunded);
        _close(key, e, Outcome.Refunded);
    }

    /// @notice Credits free unvested funds when this escrow's immutable flag permits it.
    /// @param key Active escrow key.
    function customerRefundUnvested(bytes32 key) external {
        Escrow storage e = _active(key);
        if (msg.sender != e.customer) revert Unauthorized();
        if (!e.customerMayRefundUnvested) revert RefundNotAllowed();
        uint128 amount = uint128(_balance(e) - e.frozen - _claimable(e));
        if (amount == 0) revert InvalidAmount();
        _refund(key, e, amount, Outcome.Refunded);
        _close(key, e, Outcome.Refunded);
    }

    /// @notice Opens the only dispute allowed for this escrow and freezes only its scope.
    /// @param key Active escrow.
    /// @param amount Positive scope at most its held balance.
    /// @param reasonHash Nonzero evidence commitment.
    function openDispute(bytes32 key, uint128 amount, bytes32 reasonHash) external {
        Escrow storage e = _active(key);
        if (msg.sender != e.customer) revert Unauthorized();
        if (e.dispute != DisputeState.None) revert InvalidDispute();
        if (amount == 0) revert InvalidAmount();
        uint256 maximum = _balance(e);
        if (amount > maximum) revert AmountTooLarge(amount, maximum);
        if (reasonHash == bytes32(0)) revert InvalidEvidence();
        e.carvedVested = uint128(Math.min(amount, _claimable(e)));
        e.frozen = amount;
        e.disputedAt = uint40(block.timestamp);
        e.dispute = DisputeState.Open;
        _clearSettlement(e);
        emit DisputeOpened(key, e.customer, e.arbitrator, amount, e.carvedVested, reasonHash, uint256(e.disputedAt) + e.responseWindow, uint256(e.disputedAt) + e.resolutionTimeout);
    }

    /// @notice Records the merchant's one response at or before the snapshotted deadline.
    /// @param key Disputed escrow.
    /// @param responseHash Evidence commitment, which may be zero.
    function respondToDispute(bytes32 key, bytes32 responseHash) external {
        Escrow storage e = _open(key);
        if (msg.sender != e.merchant) revert Unauthorized();
        if (block.timestamp > uint256(e.disputedAt) + e.responseWindow) revert ResponseWindowEnded();
        if (e.merchantResponded) revert AlreadyResponded();
        e.merchantResponded = true;
        emit DisputeResponded(key, e.merchant, responseHash);
    }

    /// @notice Allows the still-independent assigned arbitrator to split only frozen funds.
    /// @param key Disputed escrow.
    /// @param merchantAmount Merchant portion.
    /// @param rulingHash Ruling commitment, which may be zero.
    function resolveDispute(bytes32 key, uint128 merchantAmount, bytes32 rulingHash) external {
        Escrow storage e = _open(key);
        if (msg.sender != e.arbitrator) revert Unauthorized();
        if (block.timestamp >= uint256(e.disputedAt) + e.resolutionTimeout) revert ResolutionWindowEnded();
        _checkArbitrator(msg.sender, e.merchant, e.customer);
        if (!e.merchantResponded && block.timestamp <= uint256(e.disputedAt) + e.responseWindow) revert ResponseWindowOpen();
        uint128 customerAmount = _splitFrozen(key, e, merchantAmount, Outcome.Resolved);
        emit DisputeResolved(key, msg.sender, merchantAmount, customerAmount, rulingHash);
        _close(key, e, Outcome.Resolved);
    }

    /// @notice Splits expired frozen funds using vested-at-open value, permissionlessly.
    /// @param key Disputed escrow key.
    function expireDispute(bytes32 key) external {
        Escrow storage e = _open(key);
        if (block.timestamp < uint256(e.disputedAt) + e.resolutionTimeout) revert TimeoutNotReached();
        uint128 merchantAmount = e.carvedVested;
        uint128 customerAmount = _splitFrozen(key, e, merchantAmount, Outcome.Expired);
        emit DisputeExpired(key, msg.sender, merchantAmount, customerAmount);
        _close(key, e, Outcome.Expired);
    }

    /// @notice Proposes a split committed to frozen funds if positive, otherwise all remaining held funds.
    /// @param key Active escrow.
    /// @param merchantAmount Proposed merchant portion, no greater than the stored scope.
    function proposeSettlement(bytes32 key, uint128 merchantAmount) external {
        Escrow storage e = _active(key);
        _party(e);
        uint128 scope = uint128(_scope(e));
        if (merchantAmount > scope) revert AmountTooLarge(merchantAmount, scope);
        e.settlementId += 1;
        e.settlementProposer = msg.sender;
        e.settlementMerchantAmount = merchantAmount;
        e.settlementScope = scope;
        emit SettlementProposed(key, msg.sender, merchantAmount, scope, e.settlementId);
    }

    /// @notice Accepts the other party's exact proposal only if its committed balance scope is unchanged.
    /// @param key Active escrow.
    /// @param merchantAmount Expected merchant portion.
    /// @param settlementId Expected proposal identifier.
    function acceptSettlement(bytes32 key, uint128 merchantAmount, uint32 settlementId) external {
        Escrow storage e = _active(key);
        _party(e);
        if (e.settlementProposer == address(0) || e.settlementProposer == msg.sender || e.settlementMerchantAmount != merchantAmount || e.settlementId != settlementId) revert ProposalMismatch();
        bool disputeScoped = e.frozen > 0;
        uint128 scope = uint128(_scope(e));
        if (scope != e.settlementScope) revert SettlementScopeChanged();
        if (merchantAmount > scope) revert AmountTooLarge(merchantAmount, scope);
        uint128 customerAmount = scope - merchantAmount;
        if (disputeScoped) {
            _splitFrozen(key, e, merchantAmount, Outcome.Settled);
        } else {
            e.awarded += merchantAmount;
            _credit(e.merchant, merchantAmount);
            _refund(key, e, customerAmount, Outcome.Settled);
            _clearSettlement(e);
        }
        emit SettlementAccepted(key, msg.sender, merchantAmount, customerAmount, settlementId, disputeScoped);
        _close(key, e, Outcome.Settled);
    }

    /// @notice Proposes an independent allowlisted replacement in any Active escrow.
    /// @param key Active escrow.
    /// @param candidate Proposed replacement.
    function proposeArbitratorReplacement(bytes32 key, address candidate) external {
        Escrow storage e = _active(key);
        _party(e);
        _checkArbitrator(candidate, e.merchant, e.customer);
        e.replacementProposer = msg.sender;
        e.replacementCandidate = candidate;
        emit ArbitratorReplacementProposed(key, msg.sender, candidate);
    }

    /// @notice Accepts the other party's candidate, rechecking independence and allowlisting.
    /// @param key Active escrow.
    /// @param candidate Expected replacement candidate.
    function acceptArbitratorReplacement(bytes32 key, address candidate) external {
        Escrow storage e = _active(key);
        _party(e);
        if (e.replacementProposer == address(0) || e.replacementProposer == msg.sender || e.replacementCandidate != candidate) revert ProposalMismatch();
        _checkArbitrator(candidate, e.merchant, e.customer);
        address old = e.arbitrator;
        e.arbitrator = candidate;
        e.replacementProposer = address(0);
        e.replacementCandidate = address(0);
        emit ArbitratorReplaced(key, old, candidate);
    }

    /// @notice Withdraws the caller's full credit after zeroing liabilities; failure rolls back.
    /// @param to Nonzero recipient chosen by the beneficiary.
    function withdraw(address to) external nonReentrant { _withdraw(msg.sender, to); }

    /// @notice Permissionlessly withdraws only to the beneficiary's own registered payout.
    /// @param account Credit owner; zero payout defaults to this account.
    function withdrawToPayout(address account) external nonReentrant {
        address to = payoutAddress[account];
        _withdraw(account, to == address(0) ? account : to);
    }

    /// @notice Updates the caller's payout and consumes a nonce to invalidate old signatures.
    /// @param newPayout Recipient, or zero to reset to self.
    function setPayoutAddress(address newPayout) external {
        _setPayout(msg.sender, newPayout, _useNonce(msg.sender));
    }

    /// @notice Relays an EIP-712 beneficiary signature, supporting EOAs and ERC-1271 wallets.
    /// @param account Signer and beneficiary.
    /// @param newPayout Recipient or zero reset.
    /// @param deadline Inclusive expiry timestamp.
    /// @param signature Signature over the current nonce.
    function setPayoutAddressBySig(address account, address newPayout, uint256 deadline, bytes calldata signature) external nonReentrant {
        if (account == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert SignatureExpired();
        uint256 nonce = _useNonce(account);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(SET_PAYOUT_ADDRESS_TYPEHASH, account, newPayout, nonce, deadline)));
        if (!SignatureChecker.isValidSignatureNow(account, digest, signature)) revert InvalidSignature();
        _setPayout(account, newPayout, nonce);
    }

    /// @notice Adds a nonzero arbitrator holding no privileged escrow role.
    /// @param candidate Allowlist candidate.
    function addArbitrator(address candidate) external onlyRole(ARBITRATOR_MANAGER_ROLE) {
        _checkConflict(candidate, address(0), address(0));
        arbitrators[candidate] = true;
        emit ArbitratorAdded(candidate);
    }

    /// @notice Removes an arbitrator without affecting any deposited funds.
    /// @param candidate Arbitrator to remove.
    function removeArbitrator(address candidate) external onlyRole(ARBITRATOR_MANAGER_ROLE) {
        if (candidate == address(0)) revert ZeroAddress();
        arbitrators[candidate] = false;
        emit ArbitratorRemoved(candidate);
    }

    /// @notice Renounces non-admin roles using OpenZeppelin's standard checks; default-admin renunciation is disabled.
    /// @dev Changing the default admin requires beginDefaultAdminTransfer to a nonzero successor and delayed acceptDefaultAdminTransfer.
    /// @param role Role to renounce; DEFAULT_ADMIN_ROLE always reverts.
    /// @param callerConfirmation Must equal the caller for non-admin roles.
    function renounceRole(bytes32 role, address callerConfirmation) public override {
        if (role == DEFAULT_ADMIN_ROLE) revert AdminRenounceDisabled();
        super.renounceRole(role, callerConfirmation);
    }

    /// @notice Pauses new creation and funding only; requires the guardian role.
    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    /// @notice Resumes creation and funding; requires the default admin.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    /// @notice Updates the minimum used for new creation and funding, even while paused.
    /// @param value New minimum, from one base unit through maxEscrowAmount.
    function setMinAmount(uint256 value) external onlyRole(CONFIG_ROLE) {
        if (value == 0 || value > maxEscrowAmount) revert InvalidParameter();
        emit ParameterUpdated(MIN_AMOUNT_KEY, minAmount, value);
        minAmount = value;
    }
    /// @notice Updates the per-deposit limit without changing existing accounting.
    /// @param value New maximum in [minAmount,HARD_MAX_AMOUNT].
    function setMaxEscrowAmount(uint256 value) external onlyRole(CONFIG_ROLE) {
        if (value < minAmount || value > HARD_MAX_AMOUNT) revert InvalidParameter();
        emit ParameterUpdated(MAX_ESCROW_AMOUNT_KEY, maxEscrowAmount, value);
        maxEscrowAmount = value;
    }
    /// @notice Updates the aggregate ceiling checked on new funding only.
    /// @param value Positive ceiling; may be below already recorded liabilities.
    function setMaxAggregateExposure(uint256 value) external onlyRole(CONFIG_ROLE) {
        if (value == 0) revert InvalidParameter();
        emit ParameterUpdated(MAX_AGGREGATE_EXPOSURE_KEY, maxAggregateExposure, value);
        maxAggregateExposure = value;
    }
    /// @notice Updates the response window snapshotted by future escrows.
    /// @dev Raise the resolution timeout first if the desired response window would reach or exceed it.
    /// @param value Seconds in [1 day,30 days], strictly below resolutionTimeout.
    function setResponseWindow(uint32 value) external onlyRole(CONFIG_ROLE) {
        if (value < MIN_RESPONSE_WINDOW || value > MAX_RESPONSE_WINDOW) revert InvalidParameter();
        if (value >= resolutionTimeout) revert InvalidWindowOrder();
        emit ParameterUpdated(RESPONSE_WINDOW_KEY, responseWindow, value);
        responseWindow = value;
    }
    /// @notice Updates the resolution timeout snapshotted by future escrows.
    /// @param value Seconds in [7 days,90 days], strictly above responseWindow.
    function setResolutionTimeout(uint32 value) external onlyRole(CONFIG_ROLE) {
        if (value < MIN_RESOLUTION_TIMEOUT || value > MAX_RESOLUTION_TIMEOUT) revert InvalidParameter();
        if (value <= responseWindow) revert InvalidWindowOrder();
        emit ParameterUpdated(RESOLUTION_TIMEOUT_KEY, resolutionTimeout, value);
        resolutionTimeout = value;
    }

    /// @notice Returns all terms, accounting and proposal state; unknown keys return zero state.
    /// @param key Escrow key.
    /// @return value Stored escrow.
    function getEscrow(bytes32 key) external view returns (Escrow memory value) { return escrows[key]; }
    /// @notice Returns original-deposit linear vesting, zero before funding.
    /// @param key Escrow key.
    /// @return amount Vested original principal.
    function vestedAmount(bytes32 key) external view returns (uint256 amount) { return _vested(escrows[key]); }
    /// @notice Returns currently claimable funds, zero unless Active.
    /// @param key Escrow key.
    /// @return amount Claimable merchant credit.
    function claimableAmount(bytes32 key) external view returns (uint256 amount) { return _claimable(escrows[key]); }
    /// @notice Returns recorded held balance D-C-A-R, not token balance.
    /// @param key Escrow key.
    /// @return amount Recorded balance, zero if unfunded.
    function balanceOf(bytes32 key) external view returns (uint256 amount) {
        Escrow storage e = escrows[key];
        return e.status == Status.Active || e.status == Status.Closed ? _balance(e) : 0;
    }
    /// @notice Returns held unfrozen funds, zero for unfunded escrows.
    /// @param key Escrow key.
    /// @return amount Free recorded balance.
    function freeBalanceOf(bytes32 key) external view returns (uint256 amount) {
        Escrow storage e = escrows[key];
        return e.status == Status.Active ? _balance(e) - e.frozen : 0;
    }
    /// @notice Returns an account's recorded pull credit.
    /// @param account Beneficiary.
    /// @return amount Withdrawable base units.
    function withdrawableOf(address account) external view returns (uint256 amount) { return withdrawable[account]; }
    /// @notice Reports allowlisting only; role and party conflicts are checked separately.
    /// @param account Candidate.
    /// @return allowed Allowlist membership.
    function isArbitrator(address account) external view returns (bool allowed) { return arbitrators[account]; }
    /// @notice Computes the exact customer funding commitment, bound to this chain and contract.
    /// @param key Escrow key.
    /// @return hash Current terms hash.
    function termsHash(bytes32 key) public view returns (bytes32 hash) {
        Escrow storage e = escrows[key];
        return keccak256(abi.encode(address(this), block.chainid, key, e.merchant, e.customer, e.amount, e.vestDuration, e.arbitrator, e.customerMayRefundUnvested, e.responseWindow, e.resolutionTimeout));
    }
    /// @notice Computes an unsquattable merchant/reference key.
    /// @param merchant Merchant address.
    /// @param invoiceRef Invoice reference.
    /// @return key Escrow identifier.
    function escrowKey(address merchant, bytes32 invoiceRef) public pure returns (bytes32 key) { return keccak256(abi.encode(merchant, invoiceRef)); }
    /// @notice Returns the EIP-712 separator for RetempoEscrow version 1 on the current chain.
    /// @return separator Domain separator.
    function DOMAIN_SEPARATOR() external view returns (bytes32 separator) { return _domainSeparatorV4(); }

    function _create(bytes32 invoiceRef, address merchant, address customer, uint128 amount, uint32 vestDuration, address arbitrator, bool refundable) private returns (bytes32 key) {
        if (invoiceRef == bytes32(0)) revert InvalidReference();
        if (merchant == address(0) || customer == address(0)) revert ZeroAddress();
        if (merchant == customer) revert Unauthorized();
        _checkAmount(amount);
        if (vestDuration < MIN_VEST_DURATION || vestDuration > MAX_VEST_DURATION) revert InvalidDuration();
        _checkArbitrator(arbitrator, merchant, customer);
        key = escrowKey(merchant, invoiceRef);
        Escrow storage e = escrows[key];
        if (e.status != Status.None) revert EscrowExists();
        e.merchant = merchant;
        e.customer = customer;
        e.arbitrator = arbitrator;
        e.amount = amount;
        e.vestDuration = vestDuration;
        e.responseWindow = responseWindow;
        e.resolutionTimeout = resolutionTimeout;
        e.customerMayRefundUnvested = refundable;
        e.status = Status.Pending;
        _emitCreated(key, invoiceRef, e);
    }

    function _emitCreated(bytes32 key, bytes32 invoiceRef, Escrow storage e) private {
        emit EscrowCreated(key, e.merchant, e.customer, invoiceRef, e.amount, e.vestDuration, e.arbitrator, e.customerMayRefundUnvested, e.responseWindow, e.resolutionTimeout);
    }

    function _fund(bytes32 key, Escrow storage e, address payer, bool viaManager) private {
        uint128 amount = e.amount;
        _checkAmount(amount);
        uint256 currentExposure = totalLocked + totalWithdrawable;
        uint256 limit = maxAggregateExposure;
        if (currentExposure + amount > limit) revert ExposureExceeded(currentExposure, amount, limit);
        e.vestStart = uint40(block.timestamp);
        e.status = Status.Active;
        totalLocked += amount;
        emit ArbitratorAccepted(key, e.customer, e.arbitrator, viaManager);
        emit EscrowFunded(key, payer, amount, e.vestStart, uint40(uint256(e.vestStart) + e.vestDuration), viaManager);
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(payer, address(this), amount);
        uint256 afterBalance = usdc.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert DepositMismatch(amount, beforeBalance, afterBalance);
    }

    function _checkAmount(uint256 amount) private view {
        uint256 minimum = minAmount;
        if (amount < minimum) revert InvalidAmount();
        uint256 maximum = maxEscrowAmount;
        if (amount > maximum) revert AmountOutOfBounds(amount, minimum, maximum);
    }
    function _checkConflict(address candidate, address merchant, address customer) private view {
        if (candidate == address(0)) revert ZeroAddress();
        if (candidate == merchant || candidate == customer || hasRole(DEFAULT_ADMIN_ROLE, candidate) || hasRole(CONFIG_ROLE, candidate) || hasRole(PAUSER_ROLE, candidate) || hasRole(ARBITRATOR_MANAGER_ROLE, candidate)) revert ConflictedArbitrator();
    }
    function _checkArbitrator(address candidate, address merchant, address customer) private view {
        _checkConflict(candidate, merchant, customer);
        if (!arbitrators[candidate]) revert ArbitratorNotAllowed();
    }
    function _active(bytes32 key) private view returns (Escrow storage e) {
        e = escrows[key];
        if (e.status != Status.Active) revert InvalidStatus();
    }
    function _open(bytes32 key) private view returns (Escrow storage e) {
        e = _active(key);
        if (e.dispute != DisputeState.Open) revert InvalidDispute();
    }
    function _party(Escrow storage e) private view {
        if (msg.sender != e.merchant && msg.sender != e.customer) revert Unauthorized();
    }
    function _balance(Escrow storage e) private view returns (uint256) {
        return uint256(e.amount) - e.claimed - e.awarded - e.refunded;
    }
    function _vested(Escrow storage e) private view returns (uint256) {
        if (e.status != Status.Active && e.status != Status.Closed) return 0;
        if (block.timestamp <= e.vestStart) return 0;
        uint256 elapsed = block.timestamp - e.vestStart;
        if (elapsed >= e.vestDuration) return e.amount;
        return Math.mulDiv(e.amount, elapsed, e.vestDuration);
    }
    function _claimable(Escrow storage e) private view returns (uint256) {
        if (e.status != Status.Active) return 0;
        uint256 vested = _vested(e);
        uint256 adjusted = vested > e.carvedVested ? vested - e.carvedVested : 0;
        uint256 cap = uint256(e.amount) - e.refunded - e.awarded - e.frozen;
        uint256 entitlement = Math.min(adjusted, cap);
        return entitlement > e.claimed ? entitlement - e.claimed : 0;
    }
    function _scope(Escrow storage e) private view returns (uint256) { return e.frozen > 0 ? e.frozen : _balance(e); }
    function _credit(address account, uint256 amount) private {
        totalLocked -= amount;
        totalWithdrawable += amount;
        withdrawable[account] += amount;
    }
    function _refund(bytes32 key, Escrow storage e, uint128 amount, Outcome reason) private {
        if (amount == 0) return;
        e.refunded += amount;
        _credit(e.customer, amount);
        emit RefundCredited(key, e.customer, amount, reason, e.refunded);
    }
    function _splitFrozen(bytes32 key, Escrow storage e, uint128 merchantAmount, Outcome reason) private returns (uint128 customerAmount) {
        uint128 maximum = e.frozen;
        if (merchantAmount > maximum) revert AmountTooLarge(merchantAmount, maximum);
        customerAmount = maximum - merchantAmount;
        e.frozen = 0;
        e.dispute = DisputeState.Resolved;
        e.awarded += merchantAmount;
        _credit(e.merchant, merchantAmount);
        _refund(key, e, customerAmount, reason);
        _clearSettlement(e);
    }
    function _clearSettlement(Escrow storage e) private {
        e.settlementProposer = address(0);
        e.settlementMerchantAmount = 0;
        e.settlementScope = 0;
        // Retain the monotonic identifier so cleared/replaced proposals cannot replay.
    }
    function _close(bytes32 key, Escrow storage e, Outcome outcome) private {
        if (_balance(e) == 0 && e.frozen == 0) {
            e.status = Status.Closed;
            e.outcome = outcome;
            emit EscrowClosed(key, outcome);
        }
    }
    function _withdraw(address account, address to) private {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = withdrawable[account];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[account] = 0;
        totalWithdrawable -= amount;
        emit Withdrawn(account, to, amount);
        usdc.safeTransfer(to, amount);
    }
    function _setPayout(address account, address newPayout, uint256 nonce) private {
        payoutAddress[account] = newPayout;
        emit PayoutAddressUpdated(account, newPayout, nonce);
    }
}
