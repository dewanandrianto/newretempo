// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

interface ISafeMetadata {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

/// @notice Read-only deployment readiness inspection. This script never broadcasts or deploys.
/// @dev Safe metadata and a caller-approved runtime hash are checks, not an independent Safe audit.
/// The proxy implementation, modules, guard, fallback handler and signer custody need separate review.
contract PrepareMainnet is Script {
    uint256 public constant ARC_MAINNET_CHAIN_ID = 5042;
    address public constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    string public constant ARC_MAINNET_RPC = "https://rpc.mainnet.arc.io";
    uint48 public constant MIN_ADMIN_DELAY = 3 days;
    uint256 public constant MIN_PAYMENT = 10_000;
    uint256 public constant MAX_LAUNCH_PAYMENT = 10_000e6;

    struct Config {
        string rpcUrl;
        address usdc;
        address admin;
        bytes32 adminRuntimeCodeHash;
        address[] owners;
        uint256 threshold;
        uint48 adminDelay;
        address pauser;
        address deployer;
        uint64 deployerNonce;
        uint256 maxAggregateExposure;
        uint256 launchMaxPaymentAmount;
    }
    struct Plan { address escrow; address manager; }

    error WrongChain();
    error WrongRpc();
    error WrongToken();
    error InvalidAdmin();
    error InvalidSigners();
    error InvalidParameters();
    error NonceChanged();
    error DeploymentAddressOccupied();

    /// @notice Inspects public deployment inputs against the current local or forked state.
    /// @dev Owners must match the approved ordered getOwners() result exactly. No defaults or keys.
    function inspect(Config memory config) public view returns (Plan memory plan) {
        if (block.chainid != ARC_MAINNET_CHAIN_ID) revert WrongChain();
        if (keccak256(bytes(config.rpcUrl)) != keccak256(bytes(ARC_MAINNET_RPC))) revert WrongRpc();
        if (config.usdc != ARC_USDC || config.usdc.code.length == 0) revert WrongToken();
        if (IERC20Metadata(config.usdc).decimals() != 6) revert WrongToken();
        if (config.admin.code.length == 0 || config.adminRuntimeCodeHash == bytes32(0) || config.admin.codehash != config.adminRuntimeCodeHash) revert InvalidAdmin();
        address[] memory actualOwners = ISafeMetadata(config.admin).getOwners();
        uint256 actualThreshold = ISafeMetadata(config.admin).getThreshold();
        if (config.threshold < 2 || config.threshold > config.owners.length || config.threshold != actualThreshold || config.owners.length != actualOwners.length) revert InvalidSigners();
        for (uint256 i; i < config.owners.length; ++i) {
            if (config.owners[i] == address(0) || config.owners[i] != actualOwners[i]) revert InvalidSigners();
            for (uint256 j; j < i; ++j) if (config.owners[j] == config.owners[i]) revert InvalidSigners();
        }
        if (config.deployer == address(0) || config.deployer == config.admin || config.pauser == address(0) || config.pauser == config.admin || config.pauser == config.deployer) revert InvalidParameters();
        if (config.adminDelay < MIN_ADMIN_DELAY || config.maxAggregateExposure == 0 || config.launchMaxPaymentAmount < MIN_PAYMENT || config.launchMaxPaymentAmount > MAX_LAUNCH_PAYMENT) revert InvalidParameters();
        if (config.deployerNonce > type(uint64).max - 2) revert InvalidParameters();
        if (vm.getNonce(config.deployer) != config.deployerNonce) revert NonceChanged();
        plan.escrow = vm.computeCreateAddress(config.deployer, config.deployerNonce);
        plan.manager = vm.computeCreateAddress(config.deployer, config.deployerNonce + 1);
        if (plan.escrow.code.length != 0 || plan.manager.code.length != 0 || vm.getNonce(plan.escrow) != 0 || vm.getNonce(plan.manager) != 0) revert DeploymentAddressOccupied();
    }

    /// @notice Reads explicit public parameters and prints predictions without signing anything.
    /// @dev Run against an explicitly selected Arc mainnet read-only fork. No private-key env exists.
    function run() external view returns (Plan memory plan) {
        Config memory config;
        config.rpcUrl = vm.envString("ARC_MAINNET_RPC_URL");
        config.usdc = vm.envAddress("RETEMPO_USDC");
        config.admin = vm.envAddress("RETEMPO_ADMIN");
        config.adminRuntimeCodeHash = vm.envBytes32("RETEMPO_ADMIN_RUNTIME_CODE_HASH");
        config.owners = vm.envAddress("RETEMPO_ADMIN_OWNERS", ",");
        config.threshold = vm.envUint("RETEMPO_ADMIN_THRESHOLD");
        uint256 delay = vm.envUint("RETEMPO_ADMIN_DELAY_SECONDS");
        uint256 nonce = vm.envUint("RETEMPO_DEPLOYER_NONCE");
        if (delay > type(uint48).max || nonce > type(uint64).max) revert InvalidParameters();
        config.adminDelay = uint48(delay);
        config.deployerNonce = uint64(nonce);
        config.pauser = vm.envAddress("RETEMPO_PAUSER");
        config.deployer = vm.envAddress("RETEMPO_DEPLOYER");
        config.maxAggregateExposure = vm.envUint("RETEMPO_MAX_AGGREGATE_EXPOSURE");
        config.launchMaxPaymentAmount = vm.envUint("RETEMPO_LAUNCH_MAX_PAYMENT_AMOUNT");
        plan = inspect(config);
        console2.log("Read-only prediction; no deployment or broadcast occurred.");
        console2.log("Predicted escrow:", plan.escrow);
        console2.log("Predicted manager:", plan.manager);
        console2.log("Both contracts must start paused. CONFIG_ROLE and ARBITRATOR_MANAGER_ROLE belong to the approved admin.");
        console2.log("Apply the approved launch limits while paused before any canary or unpause.");
    }
}
