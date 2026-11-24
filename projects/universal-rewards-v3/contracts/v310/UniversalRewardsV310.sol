// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UniversalRewardsV38} from "../v38/UniversalRewardsV38.sol";
import {RewardRoutePlannerV36} from "../v36/RewardRoutePlannerV36.sol";

/// @notice A pool with config.start == 0 begins in its creation block.
/// In that mode, config.end carries the duration in seconds. Stored times are absolute.
contract UniversalRewardsV310 is UniversalRewardsV38 {
    constructor(RewardRoutePlannerV36 planner) UniversalRewardsV38(planner) {}

    function VERSION() external pure override returns (string memory) {
        return "3.10.0";
    }
}
