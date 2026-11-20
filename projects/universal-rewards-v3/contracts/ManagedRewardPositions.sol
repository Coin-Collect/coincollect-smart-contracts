// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UniversalRewards} from "./UniversalRewards.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IManagedCollection {
    function ledger() external view returns (address);
    function sourceChainId() external view returns (uint256);
    function sourceCollection() external view returns (address);
    function hasLocalHook() external view returns (bool);
}

/// @notice Statically linked accounting for collection-authenticated positions.
library ManagedRewardPositions {
    uint256 private constant SOURCE_CHAIN = 137;

    struct PositionUpdate {
        uint256 fromId;
        uint256 toId;
        address toOwner;
        uint32 fromWeight;
        uint32 toWeight;
        uint128 quantity;
        uint128 previousQuantity;
    }

    event Joined(uint256 indexed poolId, bytes32 indexed nft, address indexed owner, uint256 sourceChainId, address collection, uint256 tokenId);
    event SeatChanged(uint256 indexed poolId, bytes32 indexed nft, address indexed owner);

    error InvalidConfiguration();
    error InvalidNetwork();

    function approvalKey(IManagedCollection collection) external view returns (bytes32) {
        if (collection.ledger() != address(this)) revert InvalidConfiguration();
        uint256 chain = collection.sourceChainId();
        if (chain == SOURCE_CHAIN) {
            if (!collection.hasLocalHook()) revert InvalidConfiguration();
        } else if (block.chainid != 31337 || (chain != 8453 && chain != 42161)) revert InvalidNetwork();
        return keccak256(abi.encode(chain, collection.sourceCollection()));
    }

    function update(UniversalRewards.Pool storage pool, uint256 poolId, PositionUpdate calldata movement)
        external returns (uint32 acceptedWeight)
    {
        bytes32 fromKey = keccak256(abi.encode(SOURCE_CHAIN, msg.sender, movement.fromId));
        bytes32 toKey = keccak256(abi.encode(SOURCE_CHAIN, msg.sender, movement.toId));
        if (movement.fromId != 0) {
            UniversalRewards.Position storage previous = pool.positions[fromKey];
            _setWeight(poolId, pool, fromKey, previous, previous.seatOwner, movement.fromWeight);
            if (movement.quantity != 0) {
                for (uint256 i; i < pool.rewardTokens.length; ++i) {
                    address token = pool.rewardTokens[i];
                    uint256 moved = Math.mulDiv(pool.credits[fromKey][token], movement.quantity, movement.previousQuantity);
                    pool.credits[fromKey][token] -= moved;
                    if (movement.toId == 0) pool.rewards[token].committed -= moved;
                    else pool.credits[toKey][token] += moved;
                }
            }
        }
        if (movement.toId != 0) {
            UniversalRewards.Position storage next = pool.positions[toKey];
            if (next.collection == address(0)) {
                pool.enrollmentHistory.push(toKey);
                next.sourceChainId = SOURCE_CHAIN;
                next.collection = msg.sender;
                next.tokenId = movement.toId;
            }
            _remember(pool, movement.toOwner, toKey);
            acceptedWeight = _setWeight(poolId, pool, toKey, next, movement.toOwner, movement.toWeight);
        }
    }

    function _setWeight(
        uint256 poolId, UniversalRewards.Pool storage pool, bytes32 key, UniversalRewards.Position storage position,
        address owner, uint32 nextWeight
    ) private returns (uint32) {
        bool hasSeat = position.seatOwner != address(0);
        uint32 previous = hasSeat ? position.weight : 0;
        if (!hasSeat && nextWeight == 0) return 0;
        if (hasSeat && previous == nextWeight) {
            _realize(pool, key, previous);
            return previous;
        }
        if (nextWeight == 0) {
            _realize(pool, key, previous);
            if (--pool.seatsByWallet[owner] == 0) --pool.activeWallets;
            --pool.activeNfts;
            position.seatOwner = address(0);
            emit SeatChanged(poolId, key, address(0));
        } else if (!hasSeat) {
            uint16 seats = pool.seatsByWallet[owner];
            if (block.timestamp < pool.config.start || block.timestamp >= pool.config.end
                || pool.activeNfts == type(uint16).max || seats >= pool.config.maxNftsPerWallet
                || (seats == 0 && pool.activeWallets >= pool.config.maxWallets)) return 0;
            if (seats == 0) ++pool.activeWallets;
            pool.seatsByWallet[owner] = seats + 1;
            ++pool.activeNfts;
            position.seatOwner = owner;
            _realize(pool, key, 0);
            emit Joined(poolId, key, owner, SOURCE_CHAIN, msg.sender, position.tokenId);
        } else {
            _realize(pool, key, previous);
        }
        pool.totalWeight = pool.totalWeight - previous + nextWeight;
        pool.powerByWallet[owner] = pool.powerByWallet[owner] - previous + nextWeight;
        position.weight = nextWeight;
        return nextWeight;
    }

    function _realize(UniversalRewards.Pool storage pool, bytes32 key, uint32 weight) private {
        for (uint256 i; i < pool.rewardTokens.length; ++i) {
            address token = pool.rewardTokens[i];
            UniversalRewards.RewardIndex storage index = pool.indexes[token];
            uint256 current = index.perWeight;
            if (current != index.debt[key]) {
                if (weight != 0) pool.credits[key][token] += (current - index.debt[key]) * weight;
                index.debt[key] = current;
            }
        }
    }

    function _remember(UniversalRewards.Pool storage pool, address owner, bytes32 key) private {
        if (!pool.remembered[owner][key]) {
            pool.remembered[owner][key] = true;
            pool.walletHistory[owner].push(key);
        }
    }
}
