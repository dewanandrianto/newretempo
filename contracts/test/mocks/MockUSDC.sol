// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev 6-decimal USDC stand-in with a configurable blocklist mimicking Arc USDC:
///      any transfer/transferFrom from or to a blocked address reverts.
contract MockUSDC is ERC20 {
    error Blocked(address account);

    mapping(address => bool) public blocklisted;

    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool blocked) external {
        blocklisted[account] = blocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocklisted[from]) revert Blocked(from);
        if (blocklisted[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}
