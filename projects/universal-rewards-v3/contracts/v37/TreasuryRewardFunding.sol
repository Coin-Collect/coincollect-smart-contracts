// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UniversalRewards} from "../UniversalRewards.sol";
import {TreasuryVault} from "../TreasuryVault.sol";

/// @notice Statically linked Treasury reserve and purchase accounting.
library TreasuryRewardFunding {
    uint256 private constant PRECISION = 1e18;
    uint256 private constant BPS = 10_000;
    event RewardFunded(uint256 indexed poolId, address indexed token, address indexed funder, uint256 amount);

    function fund(
        UniversalRewards.Pool storage pool,
        uint256 poolId,
        TreasuryVault vault,
        UniversalRewards.RewardConfig[] calldata rewards
    ) external {
        pool.treasuryBacked = true;
        for (uint256 i; i < rewards.length; ++i) {
            UniversalRewards.RewardConfig calldata reward = rewards[i];
            vault.allocate(poolId, reward.token, reward.cap);
            vault.recordSpend(poolId, reward.token, reward.cap);
            pool.rewards[reward.token].inventory = reward.cap;
            emit RewardFunded(poolId, reward.token, address(vault), reward.cap);
        }
    }

    function replenishment(UniversalRewards.Pool storage pool, address token, uint256 available, TreasuryVault treasuryVault)
        external view returns (uint32 epoch, uint256 amount, uint256 target)
    {
        UniversalRewards.FundingPlan storage plan = pool.funding;
        UniversalRewards.FundingLane storage lane = pool.lanes[token];
        if (plan.interval == 0 || lane.allocationBps == 0 || block.timestamp >= pool.config.end) return (0, 0, 0);

        epoch = block.timestamp < pool.config.start
            ? 0
            : uint32(1 + (block.timestamp - pool.config.start) / plan.interval);
        uint256 duration = pool.config.end - pool.config.start;
        uint256 through = block.timestamp < pool.config.start ? pool.config.start : block.timestamp;
        uint256 remaining = pool.config.end - through;
        uint256 horizon = pool.consolidated || remaining < plan.interval ? remaining : plan.interval;
        // Round target coverage up to a whole base unit. Inventory is still capped by on-chain funding.
        target = (uint256(pool.rewards[token].cap) * horizon + duration - 1) / duration;
        if (
            plan.paused || (pool.treasuryBacked && treasuryVault.paused())
                || (lane.purchased && lane.lastEpoch == epoch) || available >= target * PRECISION
        ) {
            return (epoch, 0, target);
        }

        uint256 fundedShare = uint256(plan.deposited) * lane.allocationBps / BPS;
        uint256 maximumShare = uint256(plan.budget) * lane.allocationBps / BPS;
        uint256 windowLimit = (maximumShare * horizon + duration - 1) / duration;
        amount = fundedShare - lane.spent;
        if (!pool.consolidated && amount > windowLimit) amount = windowLimit;
        // Same-asset allocation can use exact units and avoids buying more than the coverage deficit.
        if (plan.asset == token) {
            uint256 deficit = (target * PRECISION - available + PRECISION - 1) / PRECISION;
            if (amount > deficit) amount = deficit;
        }
    }
}
