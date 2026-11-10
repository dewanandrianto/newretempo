// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IRetempoEscrow
/// @notice Minimal subscription-manager integration surface for RETEMPO escrow.
interface IRetempoEscrow {
    /// @notice Returns the immutable six-decimal settlement token.
    /// @return token The USDC ERC-20 contract.
    function usdc() external view returns (IERC20 token);

    /// @notice Returns the only subscription manager permitted to fund routed escrows.
    /// @return account The immutable manager address.
    function manager() external view returns (address account);

    /// @notice Current response window applied to newly funded escrows.
    function responseWindow() external view returns (uint32);

    /// @notice Current resolution timeout applied to newly funded escrows.
    function resolutionTimeout() external view returns (uint32);

    /// @notice Creates and funds an escrow, pulling the exact deposit from the manager.
    /// @param invoiceRef Nonzero invoice reference unique to this merchant.
    /// @param merchant Beneficiary of vested funds.
    /// @param customer Customer who accepted the arbitrator through the manager.
    /// @param amount Deposit in six-decimal USDC base units.
    /// @param vestDuration Linear vesting duration in seconds.
    /// @param arbitrator Customer-accepted, independent, allowlisted arbitrator.
    /// @param refundable Whether the customer may refund unvested free funds.
    /// @return key Deterministic merchant/invoice escrow key.
    function fundFromManager(
        bytes32 invoiceRef,
        address merchant,
        address customer,
        uint128 amount,
        uint32 vestDuration,
        address arbitrator,
        bool refundable
    ) external returns (bytes32 key);
}
