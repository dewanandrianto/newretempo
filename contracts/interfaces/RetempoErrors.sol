// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev A required address is zero.
error ZeroAddress();
/// @dev The caller or supplied party is not authorized for this operation.
error Unauthorized();
/// @dev A required external reference is zero.
error InvalidReference();
/// @dev The amount is zero, below its required minimum or exceeds the free refund balance.
error InvalidAmount();
/// @dev A configuration value is invalid for the requested operation.
error InvalidParameter();
/// @dev The observed token balance increase differs from the required deposit.
error DepositMismatch(uint256 expected, uint256 balanceBefore, uint256 balanceAfter);
/// @dev Default-admin renunciation is disabled; use the delayed transfer process.
error AdminRenounceDisabled();
/// @dev The supplied amount is outside the inclusive minimum and maximum.
error AmountOutOfBounds(uint256 amount, uint256 min, uint256 max);
