// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ManagedNftCollection} from "../ManagedNftCollection.sol";
import {UniversalRewardsV33} from "../UniversalRewardsV33.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/// @notice Adds atomic exits for the quantities selected from one managed Polygon collection.
contract ManagedNftCollectionV39 is ManagedNftCollection {
    string public constant VERSION = "3.9.0";
    uint256 public constant batchExitLimit = 16;

    struct ExitSelection {
        uint256 tokenId;
        uint128 quantity;
    }

    constructor(UniversalRewardsV33 rewards, address collection, uint32 unitLimit)
        ManagedNftCollection(rewards, 137, collection, 1155, unitLimit, address(0))
    {}

    function exitBatch(uint256 poolId, ExitSelection[] calldata selections) external nonReentrant {
        if (!hasLocalHook()) revert Unauthorized();
        if (selections.length == 0 || selections.length > batchExitLimit) revert InvalidQuantity();
        for (uint256 i; i < selections.length; ++i) {
            ExitSelection calldata selection = selections[i];
            if (i != 0 && selection.tokenId <= selections[i - 1].tokenId) revert InvalidQuantity();
            _exitLocal(poolId, selection.tokenId, msg.sender, selection.quantity);
        }
    }
}
