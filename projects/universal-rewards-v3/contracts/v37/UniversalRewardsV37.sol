// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UniversalRewardsV36} from "../v36/UniversalRewardsV36.sol";
import {TreasuryRewardFunding} from "./TreasuryRewardFunding.sol";
import {RewardRoutePlannerV36} from "../v36/RewardRoutePlannerV36.sol";

/// @notice V3.6 settlement with atomic, in-kind reward funding from the attached Treasury.
contract UniversalRewardsV37 is UniversalRewardsV36 {
    bool public constant DIRECT_TREASURY_REWARDS = true;

    constructor(RewardRoutePlannerV36 planner) UniversalRewardsV36(planner) {}

    /// @dev Each cap is the amount transferred into that token's distributable inventory.
    function _fundDirectTreasuryRewards(uint256 poolId, RewardConfig[] calldata rewards) internal override {
        if (msg.sender != treasury) revert Unauthorized();
        if (address(treasuryVault) == address(0)) revert FundingUnavailable();

        TreasuryRewardFunding.fund(pools[poolId], poolId, treasuryVault, rewards);
    }
}
