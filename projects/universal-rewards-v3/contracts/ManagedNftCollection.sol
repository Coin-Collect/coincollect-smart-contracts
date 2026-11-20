// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UniversalRewardsV33, UniversalRewards, ManagedRewardPositions} from "./UniversalRewardsV33.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRewardHookCollection {
    function rewardsHook() external view returns (address);
}

interface IRewardJournalStatus {
    function allowsClaims(address adapter) external view returns (bool);
}

/// @notice Tracks non-custodial units from a reviewed collection or an isolated, ordered remote journal.
contract ManagedNftCollection is ReentrancyGuard {
    uint256 public constant MAX_TRACKED_POOLS = 8;

    enum Action { Transfer, Join, Exit, Release }

    struct Position {
        uint128 entitled;
        uint32 active;
    }

    struct PositionOwner {
        uint256 underlyingId;
        uint256 poolId;
        address account;
        bool released;
    }

    error Unauthorized();
    error InvalidQuantity();
    error PoolLimit();
    error UnsupportedCollection();
    error NoSeat();

    event UnitsChanged(uint256 indexed poolId, uint256 indexed tokenId, address indexed account, uint128 entitled, uint32 active);
    event CreditReleased(uint256 indexed poolId, uint256 indexed tokenId, address indexed account);

    UniversalRewardsV33 public immutable ledger;
    uint256 public immutable sourceChainId;
    address public immutable sourceCollection;
    uint16 public immutable standard;
    uint32 public immutable maxUnits;
    address public immutable journal;
    mapping(uint256 => Position) public positions;
    mapping(uint256 => uint256) public activeUnits;
    mapping(uint256 => uint32) private configuredLimit;
    mapping(uint256 => PositionOwner) public positionInfo;
    uint256[] private trackedPools;

    constructor(
        UniversalRewardsV33 rewards, uint256 chain, address collection, uint16 tokenStandard, uint32 unitLimit, address relay
    ) {
        if (collection == address(0) || unitLimit == 0 || (tokenStandard != 721 && tokenStandard != 1155)
            || (tokenStandard == 721 && unitLimit != 1)) revert UnsupportedCollection();
        if (chain == 137) {
            if (relay != address(0) || tokenStandard != 1155 || collection.code.length == 0) {
                revert UnsupportedCollection();
            }
        } else if (block.chainid != 31337 || (chain != 8453 && chain != 42161) || relay.code.length == 0) {
            revert UnsupportedCollection();
        }
        ledger = rewards;
        sourceChainId = chain;
        sourceCollection = collection;
        standard = tokenStandard;
        maxUnits = unitLimit;
        journal = relay;
    }

    function positionId(uint256 poolId, uint256 tokenId, address account, bool released)
        public pure returns (uint256)
    {
        return uint256(keccak256(abi.encode(poolId, tokenId, account, released)));
    }

    /// @notice The settlement ledger uses this restricted lookup for payment authorization.
    function ownerOf(uint256 id) external view returns (address) {
        PositionOwner storage info = positionInfo[id];
        if (info.released) {
            if (sourceChainId != 137 && !IRewardJournalStatus(journal).allowsClaims(address(this))) return address(0);
            return info.account;
        }
        if (sourceChainId != 137 || info.account == address(0)) return address(0);
        if (IRewardHookCollection(sourceCollection).rewardsHook() != address(this)) return address(0);
        return IERC1155(sourceCollection).balanceOf(info.account, info.underlyingId) >= positions[id].entitled
            ? info.account : address(0);
    }

    function unitLimit(uint256 poolId) public view returns (uint32) {
        uint32 limit = configuredLimit[poolId];
        return limit == 0 ? maxUnits : limit;
    }

    function setUnitLimit(uint256 poolId, uint32 limit) external {
        if (msg.sender != ledger.admin()) revert Unauthorized();
        (UniversalRewards.PoolConfig memory config,,,,) = ledger.poolState(poolId);
        if (block.timestamp >= config.start || limit == 0 || limit > maxUnits
            || ledger.managedWeight(poolId, address(this)) == 0) revert InvalidQuantity();
        _power(poolId, limit);
        configuredLimit[poolId] = limit;
    }

    function trackPools() external view returns (uint256[] memory) {
        return trackedPools;
    }

    function join(uint256 poolId, uint256 tokenId, uint32 quantity) external nonReentrant {
        if (sourceChainId != 137 || IRewardHookCollection(sourceCollection).rewardsHook() != address(this)) {
            revert UnsupportedCollection();
        }
        _join(poolId, tokenId, msg.sender, quantity, IERC1155(sourceCollection).balanceOf(msg.sender, tokenId));
    }

    function exit(uint256 poolId, uint256 tokenId, uint128 quantity) external nonReentrant {
        if (sourceChainId != 137 || IRewardHookCollection(sourceCollection).rewardsHook() != address(this)) {
            revert Unauthorized();
        }
        uint256 id = positionId(poolId, tokenId, msg.sender, false);
        if (IERC1155(sourceCollection).balanceOf(msg.sender, tokenId) < positions[id].entitled) revert InvalidQuantity();
        _release(poolId, tokenId, msg.sender, quantity, true);
    }

    /// @notice The collection invokes this while applying both TransferSingle and TransferBatch.
    function onTransfer(address from, address to, uint256 tokenId, uint256 quantity) external nonReentrant {
        if (sourceChainId != 137 || msg.sender != sourceCollection) revert Unauthorized();
        _transfer(from, to, tokenId, quantity);
    }

    /// @notice A source-authorized Join or Release is a journal action, never a reusable owner certificate.
    function applyObservation(
        Action action, uint256 poolId, uint256 tokenId, address from, address to, uint128 amount, uint128 balance
    ) external nonReentrant {
        if (msg.sender != journal) revert Unauthorized();
        if (action == Action.Transfer) _transfer(from, to, tokenId, amount);
        else if (action == Action.Join) {
            if (amount > type(uint32).max) revert InvalidQuantity();
            (UniversalRewards.PoolConfig memory config,,,,) = ledger.poolState(poolId);
            // A delayed observation must never block the rest of the collection's transfer stream.
            if (block.timestamp >= config.start && block.timestamp < config.end) {
                _join(poolId, tokenId, from, uint32(amount), balance);
            }
        } else {
            (UniversalRewards.PoolConfig memory config,,,,) = ledger.poolState(poolId);
            if (block.timestamp < uint256(config.end) + ledger.CLAIM_PERIOD()) {
                _release(poolId, tokenId, from, amount, action == Action.Exit);
            }
        }
    }

    function _join(uint256 poolId, uint256 tokenId, address owner, uint32 amount, uint256 owned) private {
        uint256 id = positionId(poolId, tokenId, owner, false);
        Position storage position = positions[id];
        uint32 active = position.active + amount;
        uint32 limit = unitLimit(poolId);
        if (amount == 0 || active > limit || owned < active || owned < position.entitled) revert InvalidQuantity();
        _track(poolId);
        _power(poolId, limit);
        uint32 power = _power(poolId, active);
        uint32 accepted = ledger.updateManagedPosition(poolId,
            ManagedRewardPositions.PositionUpdate(0, id, owner, 0, power, 0, 0));
        if (accepted != power) revert NoSeat();
        positionInfo[id] = PositionOwner(tokenId, poolId, owner, false);
        if (position.entitled < active) position.entitled = active;
        position.active = active;
        activeUnits[poolId] += amount;
        emit UnitsChanged(poolId, tokenId, owner, position.entitled, active);
    }

    function _track(uint256 poolId) private {
        bool present;
        uint256 i;
        while (i < trackedPools.length) {
            uint256 track = trackedPools[i];
            (UniversalRewards.PoolConfig memory config,,,,) = ledger.poolState(track);
            if (block.timestamp >= uint256(config.end) + ledger.CLAIM_PERIOD()) {
                trackedPools[i] = trackedPools[trackedPools.length - 1];
                trackedPools.pop();
            } else {
                if (track == poolId) present = true;
                ++i;
            }
        }
        if (!present) {
            if (trackedPools.length == MAX_TRACKED_POOLS) revert PoolLimit();
            trackedPools.push(poolId);
        }
    }

    function _transfer(address from, address to, uint256 tokenId, uint256 quantity) private {
        if (from == address(0) || from == to || quantity == 0) return;
        for (uint256 i; i < trackedPools.length; ++i) {
            _moveUnits(trackedPools[i], from, to, tokenId, quantity);
        }
    }

    function _moveUnits(uint256 poolId, address from, address to, uint256 tokenId, uint256 quantity) private {
        ManagedRewardPositions.PositionUpdate memory move;
        move.fromId = positionId(poolId, tokenId, from, false);
        Position storage sender = positions[move.fromId];
        if (sender.entitled == 0) return;
        (UniversalRewards.PoolConfig memory config,,,,) = ledger.poolState(poolId);
        if (block.timestamp >= uint256(config.end) + ledger.CLAIM_PERIOD()) return;
        move.previousQuantity = sender.entitled;
        move.quantity = quantity < sender.entitled ? uint128(quantity) : sender.entitled;
        uint32 activeMoved = move.quantity < sender.active ? uint32(move.quantity) : sender.active;
        uint32 nextActive;
        if (to != address(0)) {
            move.toId = positionId(poolId, tokenId, to, false);
            move.toOwner = to;
            Position storage receiver = positions[move.toId];
            nextActive = receiver.active;
            if (block.timestamp < config.end) {
                uint32 capacity = unitLimit(poolId) - receiver.active;
                nextActive += activeMoved < capacity ? activeMoved : capacity;
            }
            positionInfo[move.toId] = PositionOwner(tokenId, poolId, to, false);
            receiver.entitled += move.quantity;
        }
        move.fromWeight = _power(poolId, sender.active - activeMoved);
        move.toWeight = _power(poolId, nextActive);
        uint32 accepted = ledger.updateManagedPosition(poolId, move);
        sender.entitled -= move.quantity;
        sender.active -= activeMoved;
        activeUnits[poolId] -= activeMoved;
        emit UnitsChanged(poolId, tokenId, from, sender.entitled, sender.active);
        if (move.toId != 0) {
            Position storage receiver = positions[move.toId];
            activeUnits[poolId] -= receiver.active;
            receiver.active = accepted == 0 ? 0 : nextActive;
            activeUnits[poolId] += receiver.active;
            emit UnitsChanged(poolId, tokenId, to, receiver.entitled, receiver.active);
        }
    }

    function _release(uint256 poolId, uint256 tokenId, address owner, uint128 quantity, bool exitUnits) private {
        uint256 fromId = positionId(poolId, tokenId, owner, false);
        Position storage position = positions[fromId];
        uint128 amount = exitUnits ? quantity : position.entitled;
        if (amount == 0 || amount > position.entitled) revert InvalidQuantity();
        uint32 active = position.active;
        if (exitUnits) active -= amount < active ? uint32(amount) : active;
        uint256 toId = positionId(poolId, tokenId, owner, true);
        positionInfo[toId] = PositionOwner(tokenId, poolId, owner, true);
        ledger.updateManagedPosition(poolId, ManagedRewardPositions.PositionUpdate(
            fromId, toId, owner, _power(poolId, active), 0, amount, position.entitled
        ));
        if (exitUnits) {
            activeUnits[poolId] -= position.active - active;
            position.active = active;
            position.entitled -= amount;
            emit UnitsChanged(poolId, tokenId, owner, position.entitled, active);
        }
        emit CreditReleased(poolId, tokenId, owner);
    }

    function _power(uint256 poolId, uint32 units) private view returns (uint32) {
        uint256 weight = uint256(ledger.managedWeight(poolId, address(this))) * units;
        if (weight > type(uint32).max) revert InvalidQuantity();
        return uint32(weight);
    }
}
