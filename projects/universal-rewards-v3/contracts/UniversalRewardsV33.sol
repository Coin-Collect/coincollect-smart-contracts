// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UniversalRewards, RewardSwapAdapter, FinalizedOwnershipVerifier} from "./UniversalRewards.sol";
import {IManagedCollection, ManagedRewardPositions} from "./ManagedRewardPositions.sol";

/// @notice A versioned ledger. Remote participation is available only through isolated authenticated journals.
contract UniversalRewardsV33 is UniversalRewards {
    mapping(address => bool) public managedCollection;
    mapping(bytes32 => address) public managedAdapter;

    constructor(address governor, address[] memory tokens, address wrapped, RewardSwapAdapter adapter)
        UniversalRewards(governor, governor, tokens, wrapped, adapter, FinalizedOwnershipVerifier(address(0)))
    {}

    /// @notice The CoinCollect admin must review the immutable adapter and collection before approval.
    function approveManagedCollection(IManagedCollection collection) external {
        if (msg.sender != admin) revert Unauthorized();
        bytes32 key = ManagedRewardPositions.approvalKey(collection);
        if (managedAdapter[key] != address(0)) revert InvalidConfiguration();
        managedAdapter[key] = address(collection);
        managedCollection[address(collection)] = true;
    }

    function managedWeight(uint256 poolId, address collection) external view returns (uint32) {
        return _pool(poolId).collectionWeights[SOURCE_CHAIN][collection];
    }

    /// @notice Only the configured collection adapter can move its own power and earned credit.
    function updateManagedPosition(uint256 poolId, ManagedRewardPositions.PositionUpdate calldata update)
        external nonReentrant returns (uint32 acceptedWeight)
    {
        if (!managedCollection[msg.sender]) revert Unauthorized();
        Pool storage pool = _pool(poolId);
        if (pool.collectionWeights[SOURCE_CHAIN][msg.sender] == 0 || _claimPeriodEnded(pool)) {
            revert UnavailablePool();
        }
        _settle(poolId, pool);

        return ManagedRewardPositions.update(pool, poolId, update);
    }

    function _requireDirectCollection(address collection) internal view override {
        if (managedCollection[collection]) revert Unauthorized();
    }

    function _supportsCollection(uint256 sourceChainId, address collection) internal view override returns (bool) {
        return sourceChainId == SOURCE_CHAIN && (managedCollection[collection] || super._supportsCollection(sourceChainId, collection));
    }

    function _qualifiedOwner(uint256 sourceChainId, address collection, uint256 tokenId)
        internal view override returns (address, uint64)
    {
        return (sourceChainId == SOURCE_CHAIN ? _ownerOf(collection, tokenId) : address(0), 0);
    }

    function _nextExpiry(Pool storage, uint64 through) internal pure override returns (uint8, uint64) {
        return (0, through);
    }
}
