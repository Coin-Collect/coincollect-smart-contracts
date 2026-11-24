// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Measures exact payouts in the ledger's context via a statically linked library.
library RewardTransferV38 {
    using SafeERC20 for IERC20;

    error InvalidReceipt();

    function transferExact(address token, address receiver, uint256 amount) external {
        IERC20 asset = IERC20(token);
        uint256 beforePool = asset.balanceOf(address(this));
        uint256 beforeReceiver = asset.balanceOf(receiver);
        asset.safeTransfer(receiver, amount);
        if (beforePool - asset.balanceOf(address(this)) != amount || asset.balanceOf(receiver) - beforeReceiver != amount) {
            revert InvalidReceipt();
        }
    }
}
