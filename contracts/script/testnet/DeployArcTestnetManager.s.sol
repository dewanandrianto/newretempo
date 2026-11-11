// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {RetempoEscrow} from "../../RetempoEscrow.sol";
import {RetempoSubscriptionManager} from "../../RetempoSubscriptionManager.sol";

/// @notice One-transaction completion path when the escrow transaction is already mined.
/// @dev Arc Testnet only; checks the existing escrow's pinned manager address and never unpauses.
contract DeployArcTestnetManager is Script {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    address internal constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;
    address internal constant EXPECTED_ESCROW = 0x0b862d1E56fD6303e303C55e7337961DF479E747;
    address internal constant EXPECTED_MANAGER = 0x83426CFF6bEf85058eBb7f20FcED0a9965e73e25;
    uint48 internal constant ADMIN_DELAY = 1 days;
    uint256 internal constant AGGREGATE_CAP = 10_000 * 1_000_000;

    error WrongChainId(uint256 actual);
    error InvalidExistingEscrow();
    error UnexpectedManagerAddress(address expected, address actual);
    error ManagerAlreadyDeployed();
    error InvalidManagerState();

    event ArcTestnetManagerDeployed(address indexed deployer, address indexed pauser, address indexed manager, address escrow, address usdc);

    function run() external returns (RetempoSubscriptionManager manager) {
        if (block.chainid != ARC_TESTNET_CHAIN_ID) revert WrongChainId(block.chainid);
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address pauser = vm.envAddress("PAUSER_ADDRESS");
        address escrowAddress = vm.envAddress("ESCROW_ADDRESS");
        if (escrowAddress != EXPECTED_ESCROW || escrowAddress.code.length == 0 || deployer == pauser) {
            revert InvalidExistingEscrow();
        }

        RetempoEscrow escrow = RetempoEscrow(escrowAddress);
        uint256 nonce = vm.getNonce(deployer);
        address predictedManager = vm.computeCreateAddress(deployer, nonce);
        if (predictedManager != EXPECTED_MANAGER) revert UnexpectedManagerAddress(EXPECTED_MANAGER, predictedManager);
        if (predictedManager.code.length != 0) revert ManagerAlreadyDeployed();
        if (
            !escrow.paused() || address(escrow.usdc()) != ARC_TESTNET_USDC || escrow.manager() != EXPECTED_MANAGER ||
            escrow.maxAggregateExposure() != AGGREGATE_CAP || escrow.defaultAdminDelay() != ADMIN_DELAY
        ) revert InvalidExistingEscrow();

        vm.startBroadcast(deployerKey);
        manager = new RetempoSubscriptionManager(
            ARC_TESTNET_USDC,
            escrowAddress,
            deployer,
            ADMIN_DELAY,
            pauser,
            deployer
        );
        vm.stopBroadcast();

        if (
            address(manager) != EXPECTED_MANAGER || !manager.paused() || address(manager.usdc()) != ARC_TESTNET_USDC ||
            address(manager.escrow()) != escrowAddress || manager.maxPaymentAmount() != AGGREGATE_CAP ||
            manager.defaultAdminDelay() != ADMIN_DELAY || !manager.hasRole(bytes32(0), deployer) ||
            !manager.hasRole(manager.CONFIG_ROLE(), deployer) || !manager.hasRole(manager.PAUSER_ROLE(), pauser)
        ) revert InvalidManagerState();

        emit ArcTestnetManagerDeployed(deployer, pauser, address(manager), escrowAddress, ARC_TESTNET_USDC);
        console2.log("RetempoSubscriptionManager (paused):", address(manager));
        console2.log("Existing RetempoEscrow remains paused:", escrowAddress);
        console2.log("Deployer/admin:", deployer);
        console2.log("Pauser/guardian:", pauser);
    }
}
