// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RewardRoutePlanner} from "../RewardRoutePlanner.sol";
import {TreasuryAssetsV36} from "./TreasuryAssetsV36.sol";

/// @notice Adds registry checks to every route leg and exact route execution for Treasury quotes.
contract RewardRoutePlannerV36 is RewardRoutePlanner {
    using SafeERC20 for IERC20;
    TreasuryAssetsV36 public immutable registry;

    constructor(TreasuryAssetsV36 assets, address wrapped) RewardRoutePlanner(assets.admin(), wrapped) {
        registry = assets;
    }

    function _assetAllowed(address token) internal view override returns (bool) {
        return super._assetAllowed(token) && registry.permitted(token, 4);
    }

    function swapExactPath(address input, address output, uint8 index, uint256 amount, uint256 callerMinimum, uint256 deadline)
        external nonReentrant returns (uint256 received)
    {
        if (deadline < block.timestamp || deadline - block.timestamp > 5 minutes) revert InvalidDeadline();
        if (callerMinimum == 0) revert InvalidRoute();
        (, uint256 minimum) = this.quotePath(input, output, index, amount, callerMinimum);
        IERC20 asset = IERC20(input);
        uint256 starting = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        if (asset.balanceOf(address(this)) != starting + amount) revert UnexpectedTransfer();

        received = this.executePath(input, output, index, amount, minimum, deadline, msg.sender);
        if (asset.balanceOf(address(this)) != starting || received < minimum) revert UnexpectedTransfer();
        emit Swapped(msg.sender, input, output, index, amount, received);
    }
}
