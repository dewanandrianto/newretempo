// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrepareMainnet, ISafeMetadata} from "../script/mainnet/PrepareMainnet.s.sol";
import {RetempoEscrow} from "../RetempoEscrow.sol";
import {RetempoSubscriptionManager} from "../RetempoSubscriptionManager.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract ReadinessSafeFixture is ISafeMetadata {
    address[] private owners;
    constructor(address one, address two) { owners.push(one); owners.push(two); }
    function getOwners() external view returns (address[] memory) { return owners; }
    function getThreshold() external pure returns (uint256) { return 2; }
}

contract PrepareMainnetTest is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    PrepareMainnet private inspector;
    PrepareMainnet.Config private config;

    function setUp() public {
        vm.chainId(5042);
        if (USDC.code.length == 0) vm.etch(USDC, address(new MockUSDC()).code);
        inspector = new PrepareMainnet();
        ReadinessSafeFixture safe = new ReadinessSafeFixture(makeAddr("signer-one"), makeAddr("signer-two"));
        config.rpcUrl = "https://rpc.mainnet.arc.io";
        config.usdc = USDC;
        config.admin = address(safe);
        config.adminRuntimeCodeHash = address(safe).codehash;
        config.owners = safe.getOwners();
        config.threshold = 2;
        config.adminDelay = 3 days;
        config.pauser = makeAddr("separate-guardian");
        config.deployer = address(this);
        config.deployerNonce = vm.getNonce(address(this));
        config.maxAggregateExposure = 100e6;
        config.launchMaxPaymentAmount = 1e6;
    }

    function test_ValidReadOnlyPlanDoesNotDeployOrMoveFunds() public view {
        uint64 nonceBefore = vm.getNonce(config.deployer);
        PrepareMainnet.Plan memory plan = inspector.inspect(config);
        assertEq(plan.escrow, vm.computeCreateAddress(config.deployer, nonceBefore));
        assertEq(plan.manager, vm.computeCreateAddress(config.deployer, nonceBefore + 1));
        assertEq(plan.escrow.code.length, 0);
        assertEq(plan.manager.code.length, 0);
        assertEq(vm.getNonce(config.deployer), nonceBefore);
    }

    function test_LocalDeploymentRehearsalMatchesPlanAndStartsPausedWithoutDeployerRoles() public {
        PrepareMainnet.Plan memory plan = inspector.inspect(config);
        RetempoEscrow escrow = new RetempoEscrow(USDC, plan.manager, config.admin, config.adminDelay, config.pauser, config.admin, config.admin, config.maxAggregateExposure);
        RetempoSubscriptionManager manager = new RetempoSubscriptionManager(USDC, address(escrow), config.admin, config.adminDelay, config.pauser, config.admin);
        assertEq(address(escrow), plan.escrow);
        assertEq(address(manager), plan.manager);
        assertEq(escrow.manager(), address(manager));
        assertEq(address(manager.escrow()), address(escrow));
        assertEq(address(escrow.usdc()), USDC);
        assertEq(address(manager.usdc()), USDC);
        assertTrue(escrow.paused()); assertTrue(manager.paused());
        assertEq(escrow.defaultAdmin(), config.admin); assertEq(manager.defaultAdmin(), config.admin);
        assertEq(escrow.defaultAdminDelay(), config.adminDelay);
        assertEq(manager.defaultAdminDelay(), config.adminDelay);
        assertEq(escrow.maxAggregateExposure(), config.maxAggregateExposure);
        assertTrue(escrow.hasRole(escrow.CONFIG_ROLE(), config.admin));
        assertTrue(manager.hasRole(manager.CONFIG_ROLE(), config.admin));
        assertTrue(escrow.hasRole(escrow.ARBITRATOR_MANAGER_ROLE(), config.admin));
        assertTrue(escrow.hasRole(escrow.PAUSER_ROLE(), config.pauser));
        assertTrue(manager.hasRole(manager.PAUSER_ROLE(), config.pauser));
        assertFalse(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), config.deployer));
        assertFalse(manager.hasRole(manager.DEFAULT_ADMIN_ROLE(), config.deployer));
        assertFalse(escrow.hasRole(escrow.CONFIG_ROLE(), config.deployer));
        assertFalse(manager.hasRole(manager.CONFIG_ROLE(), config.deployer));
        assertFalse(escrow.hasRole(escrow.ARBITRATOR_MANAGER_ROLE(), config.deployer));
        assertFalse(escrow.hasRole(escrow.PAUSER_ROLE(), config.deployer));
        assertFalse(manager.hasRole(manager.PAUSER_ROLE(), config.deployer));
        vm.startPrank(config.admin);
        manager.setMaxPaymentAmount(config.launchMaxPaymentAmount);
        escrow.setMaxEscrowAmount(config.launchMaxPaymentAmount);
        vm.stopPrank();
        assertTrue(escrow.paused()); assertTrue(manager.paused());
        assertEq(manager.maxPaymentAmount(), config.launchMaxPaymentAmount);
        assertEq(escrow.maxEscrowAmount(), config.launchMaxPaymentAmount);
    }

    function test_RejectsOccupiedPredictedEscrow() public {
        PrepareMainnet.Plan memory plan = inspector.inspect(config);
        vm.etch(plan.escrow, hex"00");
        vm.expectRevert(PrepareMainnet.DeploymentAddressOccupied.selector);
        inspector.inspect(config);
    }
    function test_RejectsOccupiedPredictedManagerNonce() public {
        PrepareMainnet.Plan memory plan = inspector.inspect(config);
        vm.setNonce(plan.manager, 1);
        vm.expectRevert(PrepareMainnet.DeploymentAddressOccupied.selector);
        inspector.inspect(config);
    }
    function test_RejectsZeroDeployer() public { config.deployer = address(0); vm.expectRevert(PrepareMainnet.InvalidParameters.selector); inspector.inspect(config); }
    function test_RejectsDeployerNonceOverflow() public { config.deployerNonce = type(uint64).max; vm.expectRevert(PrepareMainnet.InvalidParameters.selector); inspector.inspect(config); }

    function test_RejectsWrongChain() public { vm.chainId(5042002); vm.expectRevert(PrepareMainnet.WrongChain.selector); inspector.inspect(config); }
    function test_RejectsUnapprovedRpc() public { config.rpcUrl = "https://unapproved.invalid"; vm.expectRevert(PrepareMainnet.WrongRpc.selector); inspector.inspect(config); }
    function test_RejectsWrongUsdcAddress() public { config.usdc = makeAddr("wrong-token"); vm.expectRevert(PrepareMainnet.WrongToken.selector); inspector.inspect(config); }
    function test_RejectsWrongUsdcDecimals() public { vm.mockCall(USDC, abi.encodeWithSignature("decimals()"), abi.encode(uint8(18))); vm.expectRevert(PrepareMainnet.WrongToken.selector); inspector.inspect(config); }
    function test_RejectsEoaAdmin() public { config.admin = makeAddr("eoa-admin"); vm.expectRevert(PrepareMainnet.InvalidAdmin.selector); inspector.inspect(config); }
    function test_RejectsUnapprovedAdminBytecode() public { config.adminRuntimeCodeHash = bytes32(uint256(1)); vm.expectRevert(PrepareMainnet.InvalidAdmin.selector); inspector.inspect(config); }
    function test_RejectsMissingAdminBytecodeApproval() public { config.adminRuntimeCodeHash = bytes32(0); vm.expectRevert(PrepareMainnet.InvalidAdmin.selector); inspector.inspect(config); }
    function test_RejectsThresholdMismatch() public { config.threshold = 1; vm.expectRevert(PrepareMainnet.InvalidSigners.selector); inspector.inspect(config); }
    function test_RejectsSignerMismatch() public { config.owners[0] = makeAddr("unapproved-signer"); vm.expectRevert(PrepareMainnet.InvalidSigners.selector); inspector.inspect(config); }
    function test_RejectsDuplicateSignerManifest() public { config.owners[1] = config.owners[0]; vm.expectRevert(PrepareMainnet.InvalidSigners.selector); inspector.inspect(config); }
    function test_RejectsOwnerCountMismatch() public { config.owners = new address[](0); vm.expectRevert(PrepareMainnet.InvalidSigners.selector); inspector.inspect(config); }
    function test_RejectsShortAdminDelay() public { config.adminDelay = 0; vm.expectRevert(PrepareMainnet.InvalidParameters.selector); inspector.inspect(config); }
    function test_RejectsAdminGuardianOverlap() public { config.pauser = config.admin; vm.expectRevert(PrepareMainnet.InvalidParameters.selector); inspector.inspect(config); }
    function test_RejectsDeployerGuardianOverlap() public { config.pauser = config.deployer; vm.expectRevert(PrepareMainnet.InvalidParameters.selector); inspector.inspect(config); }
    function test_RejectsZeroGuardian() public { config.pauser = address(0); vm.expectRevert(PrepareMainnet.InvalidParameters.selector); inspector.inspect(config); }
    function test_RejectsDeployerAdminOverlap() public { config.deployer = config.admin; vm.expectRevert(PrepareMainnet.InvalidParameters.selector); inspector.inspect(config); }
    function test_RejectsChangedDeployerNonce() public { config.deployerNonce += 1; vm.expectRevert(PrepareMainnet.NonceChanged.selector); inspector.inspect(config); }
    function test_RejectsZeroAggregateExposure() public { config.maxAggregateExposure = 0; vm.expectRevert(PrepareMainnet.InvalidParameters.selector); inspector.inspect(config); }
    function test_RejectsZeroLaunchPaymentLimit() public { config.launchMaxPaymentAmount = 0; vm.expectRevert(PrepareMainnet.InvalidParameters.selector); inspector.inspect(config); }
    function test_RejectsUnreviewedLargeLaunchPaymentLimit() public { config.launchMaxPaymentAmount = 10_000e6 + 1; vm.expectRevert(PrepareMainnet.InvalidParameters.selector); inspector.inspect(config); }
}
