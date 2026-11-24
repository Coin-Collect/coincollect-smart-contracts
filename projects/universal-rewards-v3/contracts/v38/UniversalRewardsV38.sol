// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UniversalRewardsV37} from "../v37/UniversalRewardsV37.sol";
import {RewardRoutePlannerV36} from "../v36/RewardRoutePlannerV36.sol";

/// @notice Direct Treasury rewards with atomic batch Harvest and Unstake.
contract UniversalRewardsV38 is UniversalRewardsV37 {
    string public constant VERSION = "3.8.0";

    constructor(RewardRoutePlannerV36 planner) UniversalRewardsV37(planner) {}

    function batchPositionLimit() external pure returns (uint256) {
        return MAX_BATCH;
    }

    /// @notice Pay every reward token for the supplied positions in one transaction.
    function claimBatch(uint256 poolId, NftRef[] calldata nfts) external nonReentrant {
        _manageBatch(poolId, nfts, false);
    }

    /// @notice Remove the supplied direct positions and pay their outstanding rewards.
    function exitBatch(uint256 poolId, NftRef[] calldata nfts) external nonReentrant {
        _manageBatch(poolId, nfts, true);
    }

    function _manageBatch(uint256 poolId, NftRef[] calldata nfts, bool exiting) private {
        if (nfts.length == 0 || nfts.length > MAX_BATCH) revert InvalidConfiguration();
        for (uint256 i; i < nfts.length; ++i) {
            NftRef calldata nft = nfts[i];
            _claimOrExit(poolId, nft.sourceChainId, nft.collection, nft.tokenId, exiting);
        }
    }
}
