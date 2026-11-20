// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Settlement ledger for non-custodial ERC-721 rewards.
contract UniversalRewards is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant SOURCE_CHAIN = 137;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_POSITIONS = 32;
    uint256 public constant MAX_REWARDS = 4;
    uint256 public constant MAX_COLLECTIONS = 16;
    uint256 private constant MAX_WEIGHT = 1e9;

    struct PoolConfig {
        uint64 start;
        uint64 end;
        uint8 threshold;
        uint8 maxWallets;
        uint8 maxNftsPerWallet;
        string metadataURI;
    }

    struct CollectionRule {
        uint256 sourceChainId;
        address collection;
        uint32 weight;
    }

    struct RewardConfig {
        address token;
        uint128 cap;
    }

    struct Reward {
        uint128 cap;
        uint128 inventory;
        uint256 committed;
    }

    struct Position {
        address collection;
        uint32 weight;
        uint256 tokenId;
        address seatOwner;
    }

    struct Pool {
        PoolConfig config;
        uint64 checkedUntil;
        uint8 activeWallets;
        uint64 totalWeight;
        CollectionRule[] collections;
        address[] rewardTokens;
        bytes32[] roster;
        mapping(address => uint32) collectionWeights;
        mapping(address => Reward) rewards;
        mapping(address => uint8) seatsByWallet;
        mapping(bytes32 => Position) positions;
        mapping(bytes32 => mapping(address => uint256)) credits;
    }

    error Unauthorized();
    error InvalidNetwork();
    error InvalidConfiguration();
    error UnavailablePool();
    error InvalidToken();
    error NoSeatAvailable();
    error NotCurrentOwner();
    error AlreadyEnrolled();
    error NotEnrolled();
    error InvalidReceipt();
    error PoolNotEnded();

    event PoolCreated(uint256 indexed poolId, uint64 start, uint64 end, string metadataURI);
    event RewardFunded(uint256 indexed poolId, address indexed token, address indexed funder, uint256 amount);
    event Joined(uint256 indexed poolId, bytes32 indexed nft, address indexed owner, address collection, uint256 tokenId);
    event SeatChanged(uint256 indexed poolId, bytes32 indexed nft, address indexed owner);
    event Checkpoint(uint256 indexed poolId, uint64 checkedUntil, uint8 activeWallets, uint64 totalWeight);
    event Claimed(uint256 indexed poolId, bytes32 indexed nft, address indexed token, address owner, uint256 amount);
    event SurplusRecovered(uint256 indexed poolId, address indexed token, uint256 amount);

    address public immutable admin;
    address public immutable treasury;
    uint256 public poolCount;
    mapping(address => bool) public supportedTokens;
    mapping(uint256 => Pool) private pools;

    constructor(address poolAdmin, address surplusTreasury, address[] memory tokens) {
        if (block.chainid != SOURCE_CHAIN && block.chainid != 31337) revert InvalidNetwork();
        if (poolAdmin == address(0) || surplusTreasury == address(0) || tokens.length == 0 || tokens.length > 32) {
            revert InvalidConfiguration();
        }
        admin = poolAdmin;
        treasury = surplusTreasury;
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i].code.length == 0 || supportedTokens[tokens[i]]) revert InvalidToken();
            supportedTokens[tokens[i]] = true;
        }
    }

    function createPool(PoolConfig calldata config, CollectionRule[] calldata collections, RewardConfig[] calldata rewards)
        external
        nonReentrant
        returns (uint256 poolId)
    {
        if (msg.sender != admin) revert Unauthorized();
        if (
            config.start < block.timestamp || config.end <= config.start || config.end - config.start > 4 * 365 days
                || config.maxWallets == 0 || config.maxWallets > MAX_POSITIONS || config.threshold > config.maxWallets
                || config.maxNftsPerWallet == 0 || config.maxNftsPerWallet > MAX_POSITIONS
                || bytes(config.metadataURI).length > 512 || collections.length == 0 || collections.length > MAX_COLLECTIONS
                || rewards.length == 0 || rewards.length > MAX_REWARDS
        ) revert InvalidConfiguration();

        poolId = ++poolCount;
        Pool storage pool = pools[poolId];
        pool.config = config;
        pool.checkedUntil = config.start;
        for (uint256 i; i < collections.length; ++i) {
            CollectionRule calldata rule = collections[i];
            if (
                rule.sourceChainId != SOURCE_CHAIN || rule.weight == 0 || rule.weight > MAX_WEIGHT
                    || pool.collectionWeights[rule.collection] != 0 || !_isErc721(rule.collection)
            ) revert InvalidConfiguration();
            pool.collections.push(rule);
            pool.collectionWeights[rule.collection] = rule.weight;
        }
        for (uint256 i; i < rewards.length; ++i) {
            RewardConfig calldata reward = rewards[i];
            if (!supportedTokens[reward.token] || reward.cap == 0 || pool.rewards[reward.token].cap != 0) {
                revert InvalidToken();
            }
            pool.rewardTokens.push(reward.token);
            pool.rewards[reward.token].cap = reward.cap;
        }
        emit PoolCreated(poolId, config.start, config.end, config.metadataURI);
    }

    function nftKey(uint256 sourceChainId, address collection, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, collection, tokenId));
    }

    function poolState(uint256 poolId)
        external
        view
        returns (PoolConfig memory config, uint64 checkedUntil, uint8 activeWallets, uint64 totalWeight, uint256 activeNfts)
    {
        Pool storage pool = _pool(poolId);
        return (pool.config, pool.checkedUntil, pool.activeWallets, pool.totalWeight, pool.roster.length);
    }

    function collectionRules(uint256 poolId) external view returns (CollectionRule[] memory) {
        return _pool(poolId).collections;
    }

    function rewardsOf(uint256 poolId) external view returns (address[] memory) {
        return _pool(poolId).rewardTokens;
    }

    function rewardState(uint256 poolId, address token) external view returns (Reward memory) {
        return _pool(poolId).rewards[token];
    }

    function positionState(uint256 poolId, bytes32 key) external view returns (Position memory) {
        return _pool(poolId).positions[key];
    }

    function walletsNftCount(uint256 poolId, address account) external view returns (uint256) {
        return _pool(poolId).seatsByWallet[account];
    }

    /// @notice Preview uses the last roster for elapsed time, just as the next checkpoint does.
    function claimable(uint256 poolId, bytes32 key, address token) external view returns (uint256) {
        Pool storage pool = _pool(poolId);
        uint256 credit = pool.credits[key][token];
        Position storage position = pool.positions[key];
        if (position.seatOwner != address(0)) {
            uint256 amount = _intervalEmission(pool, pool.rewards[token], _through(pool));
            credit += amount * position.weight / pool.totalWeight;
        }
        return credit / PRECISION;
    }

    function fundReward(uint256 poolId, address token, uint128 amount) external nonReentrant {
        Pool storage pool = _pool(poolId);
        Reward storage reward = pool.rewards[token];
        if (reward.cap == 0 || amount == 0 || block.timestamp >= pool.config.end) revert InvalidToken();
        _settle(poolId, pool);
        IERC20 asset = IERC20(token);
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        if (asset.balanceOf(address(this)) - beforeBalance != amount) revert InvalidReceipt();
        reward.inventory += amount;
        emit RewardFunded(poolId, token, msg.sender, amount);
    }

    function join(uint256 poolId, address collection, uint256 tokenId) external nonReentrant {
        Pool storage pool = _pool(poolId);
        if (block.timestamp < pool.config.start || block.timestamp >= pool.config.end) revert UnavailablePool();
        uint32 weight = pool.collectionWeights[collection];
        if (weight == 0 || _ownerOf(collection, tokenId) != msg.sender) revert NotCurrentOwner();
        _checkpoint(poolId, pool);
        bytes32 key = nftKey(SOURCE_CHAIN, collection, tokenId);
        Position storage position = pool.positions[key];
        if (position.seatOwner != address(0)) revert AlreadyEnrolled();
        if (pool.roster.length == MAX_POSITIONS || !_canSeat(pool, msg.sender)) revert NoSeatAvailable();
        position.collection = collection;
        position.tokenId = tokenId;
        position.weight = weight;
        _attach(pool, position, msg.sender);
        pool.roster.push(key);
        emit Joined(poolId, key, msg.sender, collection, tokenId);
    }

    /// @notice Owner transfers reconcile at checkpoints. Anyone may advance observation for a pool.
    function checkpoint(uint256 poolId) external nonReentrant {
        Pool storage pool = _pool(poolId);
        _checkpoint(poolId, pool);
    }

    function claim(uint256 poolId, address collection, uint256 tokenId) external nonReentrant {
        (Pool storage pool, bytes32 key) = _ownedPosition(poolId, collection, tokenId);
        for (uint256 i; i < pool.rewardTokens.length; ++i) _pay(poolId, pool, key, pool.rewardTokens[i]);
    }

    /// @notice A single-token claim stays useful if another reward token is paused.
    function claimReward(uint256 poolId, address collection, uint256 tokenId, address rewardToken) external nonReentrant {
        (Pool storage pool, bytes32 key) = _ownedPosition(poolId, collection, tokenId);
        if (pool.rewards[rewardToken].cap == 0) revert InvalidToken();
        _pay(poolId, pool, key, rewardToken);
    }

    function exit(uint256 poolId, address collection, uint256 tokenId) external nonReentrant {
        (Pool storage pool, bytes32 key) = _ownedPosition(poolId, collection, tokenId);
        _leave(poolId, pool, key);
        for (uint256 i; i < pool.rewardTokens.length; ++i) _pay(poolId, pool, key, pool.rewardTokens[i]);
    }

    /// @notice Releases the seat if an ERC-20 transfer is blocked. Preserves all claims.
    function leave(uint256 poolId, address collection, uint256 tokenId) external nonReentrant {
        (Pool storage pool, bytes32 key) = _ownedPosition(poolId, collection, tokenId);
        _leave(poolId, pool, key);
    }

    function recoverSurplus(uint256 poolId, address token) external nonReentrant returns (uint256 amount) {
        Pool storage pool = _pool(poolId);
        if (block.timestamp < pool.config.end) revert PoolNotEnded();
        _settle(poolId, pool);
        Reward storage reward = pool.rewards[token];
        if (reward.cap == 0) revert InvalidToken();
        amount = _available(reward) / PRECISION;
        reward.inventory -= uint128(amount);
        if (amount != 0) {
            _transferExact(token, treasury, amount);
            emit SurplusRecovered(poolId, token, amount);
        }
    }

    function _pool(uint256 poolId) private view returns (Pool storage pool) {
        if (poolId == 0 || poolId > poolCount) revert UnavailablePool();
        return pools[poolId];
    }

    function _ownedPosition(uint256 poolId, address collection, uint256 tokenId)
        private
        returns (Pool storage pool, bytes32 key)
    {
        pool = _pool(poolId);
        key = nftKey(SOURCE_CHAIN, collection, tokenId);
        if (pool.positions[key].collection != collection || collection == address(0)) revert NotEnrolled();
        if (_ownerOf(collection, tokenId) != msg.sender) revert NotCurrentOwner();
        _checkpoint(poolId, pool);
    }

    function _isErc721(address collection) private view returns (bool) {
        (bool ok, uint256 value) = _readWord(
            collection,
            abi.encodeCall(IERC165.supportsInterface, (type(IERC721).interfaceId))
        );
        return ok && value == 1;
    }

    function _ownerOf(address collection, uint256 tokenId) private view returns (address) {
        (bool ok, uint256 value) = _readWord(collection, abi.encodeCall(IERC721.ownerOf, (tokenId)));
        if (!ok || value >> 160 != 0) return address(0);
        return address(uint160(value));
    }

    function _readWord(address target, bytes memory input) private view returns (bool ok, uint256 value) {
        assembly ("memory-safe") {
            ok := staticcall(50000, target, add(input, 0x20), mload(input), 0, 0x20)
            ok := and(ok, eq(returndatasize(), 0x20))
            value := mload(0)
        }
    }

    function _through(Pool storage pool) private view returns (uint64) {
        return block.timestamp < pool.config.end ? uint64(block.timestamp) : pool.config.end;
    }

    function _available(Reward storage reward) private view returns (uint256) {
        return uint256(reward.inventory) * PRECISION - reward.committed;
    }

    function _intervalEmission(Pool storage pool, Reward storage reward, uint64 through) private view returns (uint256) {
        if (through <= pool.checkedUntil || pool.totalWeight == 0) return 0;
        uint256 duration = pool.config.end - pool.config.start;
        uint256 cap = uint256(reward.cap) * PRECISION;
        uint256 amount = cap * (through - pool.config.start) / duration
            - cap * (pool.checkedUntil - pool.config.start) / duration;
        if (pool.activeWallets < pool.config.threshold) {
            amount = amount * pool.activeWallets / pool.config.threshold;
        }
        uint256 available = _available(reward);
        return amount < available ? amount : available;
    }

    function _settle(uint256 poolId, Pool storage pool) private {
        uint64 through = _through(pool);
        if (through <= pool.checkedUntil) return;
        for (uint256 i; i < pool.rewardTokens.length; ++i) {
            address token = pool.rewardTokens[i];
            Reward storage reward = pool.rewards[token];
            uint256 emission = _intervalEmission(pool, reward, through);
            if (emission == 0) continue;
            uint256 newlyCommitted;
            for (uint256 j; j < pool.roster.length; ++j) {
                bytes32 key = pool.roster[j];
                uint256 share = emission * pool.positions[key].weight / pool.totalWeight;
                pool.credits[key][token] += share;
                newlyCommitted += share;
            }
            reward.committed += newlyCommitted;
        }
        pool.checkedUntil = through;
        emit Checkpoint(poolId, through, pool.activeWallets, pool.totalWeight);
    }

    function _checkpoint(uint256 poolId, Pool storage pool) private {
        _settle(poolId, pool);
        if (block.timestamp >= pool.config.end) return;
        uint256 size = pool.roster.length;
        address[] memory owners = new address[](size);
        for (uint256 i; i < size; ++i) {
            Position storage position = pool.positions[pool.roster[i]];
            owners[i] = _ownerOf(position.collection, position.tokenId);
            if (owners[i] != position.seatOwner) _detach(pool, position);
        }
        uint256 remaining;
        for (uint256 i; i < size; ++i) {
            bytes32 key = pool.roster[i];
            Position storage position = pool.positions[key];
            if (position.seatOwner == address(0)) {
                if (owners[i] != address(0) && _canSeat(pool, owners[i])) _attach(pool, position, owners[i]);
                emit SeatChanged(poolId, key, position.seatOwner);
            }
            if (position.seatOwner != address(0)) {
                if (remaining != i) pool.roster[remaining] = key;
                ++remaining;
            }
        }
        while (pool.roster.length > remaining) pool.roster.pop();
    }

    function _canSeat(Pool storage pool, address owner) private view returns (bool) {
        uint256 count = pool.seatsByWallet[owner];
        return count < pool.config.maxNftsPerWallet && (count != 0 || pool.activeWallets < pool.config.maxWallets);
    }

    function _attach(Pool storage pool, Position storage position, address owner) private {
        if (pool.seatsByWallet[owner]++ == 0) ++pool.activeWallets;
        pool.totalWeight += position.weight;
        position.seatOwner = owner;
    }

    function _detach(Pool storage pool, Position storage position) private {
        if (--pool.seatsByWallet[position.seatOwner] == 0) --pool.activeWallets;
        pool.totalWeight -= position.weight;
        position.seatOwner = address(0);
    }

    function _leave(uint256 poolId, Pool storage pool, bytes32 key) private {
        Position storage position = pool.positions[key];
        if (position.seatOwner == address(0)) return;
        _detach(pool, position);
        uint256 i;
        while (pool.roster[i] != key) ++i;
        for (; i + 1 < pool.roster.length; ++i) pool.roster[i] = pool.roster[i + 1];
        pool.roster.pop();
        emit SeatChanged(poolId, key, address(0));
    }

    function _pay(uint256 poolId, Pool storage pool, bytes32 key, address token) private {
        Reward storage reward = pool.rewards[token];
        uint256 scaled = pool.credits[key][token];
        uint256 amount = scaled / PRECISION;
        uint256 consumed = block.timestamp >= pool.config.end ? scaled : amount * PRECISION;
        pool.credits[key][token] = scaled - consumed;
        reward.committed -= consumed;
        if (amount != 0) {
            // Revalidate after each previous reward token call in a multi-token payout.
            Position storage position = pool.positions[key];
            if (_ownerOf(position.collection, position.tokenId) != msg.sender) revert NotCurrentOwner();
            reward.inventory -= uint128(amount);
            _transferExact(token, msg.sender, amount);
            emit Claimed(poolId, key, token, msg.sender, amount);
        }
    }

    function _transferExact(address token, address receiver, uint256 amount) private {
        IERC20 asset = IERC20(token);
        uint256 beforePool = asset.balanceOf(address(this));
        uint256 beforeReceiver = asset.balanceOf(receiver);
        asset.safeTransfer(receiver, amount);
        if (beforePool - asset.balanceOf(address(this)) != amount || asset.balanceOf(receiver) - beforeReceiver != amount) {
            revert InvalidReceipt();
        }
    }
}
