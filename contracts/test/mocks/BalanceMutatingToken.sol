// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev 6-decimal token that, once armed, performs ONE unexpected side effect on the `nth` call (1-based) of the
///      selected hook function (transferFrom or transfer), either before or after the transfer itself completes:
///        - mint mode  : mints `amount` to `victim` (simulates an unexpected balance change, e.g. a rebase/donation
///                       landing in the middle of a payment), or
///        - call mode  : calls `callTarget` with `callPayload` as the token and BUBBLES any revert (a hostile
///                       callback whose failure aborts the surrounding payment).
contract BalanceMutatingToken is ERC20 {
    enum Hook {
        None,
        TransferFrom,
        Transfer
    }

    Hook public hook;
    bool public mutateBefore;
    uint256 public nth;
    address public victim;
    uint256 public mintAmount;
    address public callTarget;
    bytes public callPayload;

    uint256 public hookCalls; // number of calls to the armed hook function seen since arming
    bool public mutated; // true once the side effect fired

    constructor() ERC20("Balance Mutating", "BMT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Arm a one-shot mint of `amount` to `victim_` around the `nth_` call of `hook_`.
    function armMint(Hook hook_, address victim_, uint256 amount, bool before_, uint256 nth_) external {
        _reset(hook_, before_, nth_);
        victim = victim_;
        mintAmount = amount;
    }

    /// @notice Arm a one-shot callback (revert bubbles) around the `nth_` call of `hook_`.
    function armCall(Hook hook_, address target, bytes calldata payload, bool before_, uint256 nth_) external {
        _reset(hook_, before_, nth_);
        callTarget = target;
        callPayload = payload;
    }

    function disarm() external {
        _reset(Hook.None, false, 0);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool ok) {
        bool fire = _tick(Hook.TransferFrom);
        if (fire && mutateBefore) _mutate();
        ok = super.transferFrom(from, to, value);
        if (fire && !mutateBefore) _mutate();
    }

    function transfer(address to, uint256 value) public override returns (bool ok) {
        bool fire = _tick(Hook.Transfer);
        if (fire && mutateBefore) _mutate();
        ok = super.transfer(to, value);
        if (fire && !mutateBefore) _mutate();
    }

    function _reset(Hook hook_, bool before_, uint256 nth_) internal {
        hook = hook_;
        mutateBefore = before_;
        nth = nth_;
        hookCalls = 0;
        mutated = false;
        victim = address(0);
        mintAmount = 0;
        callTarget = address(0);
        delete callPayload;
    }

    function _tick(Hook h) internal returns (bool) {
        if (hook != h || mutated) return false;
        hookCalls += 1;
        return hookCalls == nth;
    }

    function _mutate() internal {
        mutated = true;
        if (callTarget != address(0)) {
            (bool ok, bytes memory ret) = callTarget.call(callPayload);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        } else {
            _mint(victim, mintAmount);
        }
    }
}
