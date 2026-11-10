// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev 6-decimal token that, once armed, calls `target` with `payload` (as the token) exactly once
///      during transferFrom or transfer, recording whether the callback succeeded and its return data.
contract ReentrantToken is ERC20 {
    enum Hook {
        None,
        TransferFrom,
        Transfer
    }

    Hook public hook;
    bool public attackBefore;
    address public target;
    bytes public payload;

    bool public attacked;
    bool public attackSucceeded;
    bytes public attackReturn;

    constructor() ERC20("Reentrant", "RNT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(Hook hook_, address target_, bytes calldata payload_, bool before_) external {
        hook = hook_;
        target = target_;
        payload = payload_;
        attackBefore = before_;
        attacked = false;
        attackSucceeded = false;
        delete attackReturn;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool ok) {
        if (attackBefore) _attack(Hook.TransferFrom);
        ok = super.transferFrom(from, to, value);
        if (!attackBefore) _attack(Hook.TransferFrom);
    }

    function transfer(address to, uint256 value) public override returns (bool ok) {
        if (attackBefore) _attack(Hook.Transfer);
        ok = super.transfer(to, value);
        if (!attackBefore) _attack(Hook.Transfer);
    }

    function _attack(Hook h) internal {
        if (hook != h || attacked) return;
        attacked = true;
        (attackSucceeded, attackReturn) = target.call(payload);
    }
}
