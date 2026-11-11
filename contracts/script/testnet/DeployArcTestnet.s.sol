// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {RetempoEscrow} from "../../RetempoEscrow.sol";
import {RetempoSubscriptionManager} from "../../RetempoSubscriptionManager.sol";

/// @notice Testnet-only deployment of the paired Retempo contracts.
/// @dev Never unpauses either contract. The chain-id check fails closed on every other network.
contract DeployArcTestnet is Script {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    address internal constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;
    uint48 internal constant ADMIN_DELAY = 1 days;
    uint256 internal constant AGGREGATE_CAP = 10_000 * 1_000_000;

    error WrongChainId(uint256 actual);
    error InvalidRoleAddresses();
    error PredictedAddressMismatch(address expected, address actual);
    error DeployerNonceNotFresh(uint64 actual);
    error AddressAlreadyOccupied(address occupied);
    error InvalidDeploymentState();

    event ArcTestnetContractsDeployed(
        address indexed deployer,
        address indexed pauser,
        address escrow,
        address manager,
        address usdc,
        uint256 aggregateCap,
        uint48 adminDelay
    );

    function run() external returns (RetempoEscrow escrow, RetempoSubscriptionManager manager) {
        if (block.chainid != ARC_TESTNET_CHAIN_ID) revert WrongChainId(block.chainid);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address pauser = vm.envAddress("PAUSER_ADDRESS");
        if (deployer == address(0) || pauser == address(0) || deployer == pauser) revert InvalidRoleAddresses();

        // This initial pair script is single-use: stop rather than create a second pair after any tx.
        uint64 deployerNonce = vm.getNonce(deployer);
        if (deployerNonce != 0) revert DeployerNonceNotFresh(deployerNonce);
        address predictedEscrow = vm.computeCreateAddress(deployer, deployerNonce);
        address predictedManager = vm.computeCreateAddress(deployer, uint256(deployerNonce) + 1);
        if (predictedEscrow.code.length != 0) revert AddressAlreadyOccupied(predictedEscrow);
        if (predictedManager.code.length != 0) revert AddressAlreadyOccupied(predictedManager);

        vm.startBroadcast(deployerKey);
        escrow = new RetempoEscrow(
            ARC_TESTNET_USDC,
            predictedManager,
            deployer,
            ADMIN_DELAY,
            pauser,
            deployer,
            deployer,
            AGGREGATE_CAP
        );
        manager = new RetempoSubscriptionManager(
            ARC_TESTNET_USDC,
            address(escrow),
            deployer,
            ADMIN_DELAY,
            pauser,
            deployer
        );
        vm.stopBroadcast();

        if (address(manager) != predictedManager) revert PredictedAddressMismatch(predictedManager, address(manager));
        if (
            !escrow.paused() || !manager.paused() ||
            address(escrow.usdc()) != ARC_TESTNET_USDC || address(manager.usdc()) != ARC_TESTNET_USDC ||
            escrow.manager() != address(manager) || address(manager.escrow()) != address(escrow) ||
            escrow.maxAggregateExposure() != AGGREGATE_CAP || manager.maxPaymentAmount() != AGGREGATE_CAP ||
            escrow.defaultAdminDelay() != ADMIN_DELAY || manager.defaultAdminDelay() != ADMIN_DELAY ||
            !escrow.hasRole(bytes32(0), deployer) || !manager.hasRole(bytes32(0), deployer) ||
            !escrow.hasRole(escrow.CONFIG_ROLE(), deployer) || !manager.hasRole(manager.CONFIG_ROLE(), deployer) ||
            !escrow.hasRole(escrow.ARBITRATOR_MANAGER_ROLE(), deployer) ||
            !escrow.hasRole(escrow.PAUSER_ROLE(), pauser) || !manager.hasRole(manager.PAUSER_ROLE(), pauser)
        ) revert InvalidDeploymentState();

        emit ArcTestnetContractsDeployed(
            deployer,
            pauser,
            address(escrow),
            address(manager),
            ARC_TESTNET_USDC,
            AGGREGATE_CAP,
            ADMIN_DELAY
        );
        console2.log("Arc Testnet USDC:", ARC_TESTNET_USDC);
        console2.log("RetempoEscrow (paused):", address(escrow));
        console2.log("RetempoSubscriptionManager (paused):", address(manager));
        console2.log("Deployer/admin:", deployer);
        console2.log("Pauser/guardian:", pauser);
        console2.log("Aggregate cap (USDC base units):", AGGREGATE_CAP);
        console2.log("Admin delay (seconds):", uint256(ADMIN_DELAY));
    }
}
