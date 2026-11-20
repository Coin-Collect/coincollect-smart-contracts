// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TreasuryVault} from "./TreasuryVault.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {RewardSwapAdapter} from "./RewardSwapAdapter.sol";
import {FinalizedOwnershipVerifier} from "./FinalizedOwnershipVerifier.sol";

interface IWrappedNative {
    function deposit() external payable;
}

/// @notice Settlement ledger for non-custodial ERC-721 rewards.
contract UniversalRewards is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant SOURCE_CHAIN = 137;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_POSITIONS = type(uint16).max;
    uint256 public constant MAX_BATCH = 32;
    uint256 private constant MAX_REMOTE_POSITIONS = 32;
    uint256 public constant MAX_REWARDS = 4;
    uint256 public constant MAX_COLLECTIONS = 16;
    uint256 private constant MAX_WEIGHT = 1e9;
    uint256 private constant BPS = 10_000;
    uint256 public constant MIN_REPLENISH_INTERVAL = 15 minutes;
    uint256 public constant MAX_REPLENISH_INTERVAL = 30 days;
    uint256 public constant MAX_REPLENISH_DEADLINE = 5 minutes;
    uint256 public constant CLAIM_PERIOD = 30 days;

    struct PoolConfig {
        uint64 start;
        uint64 end;
        uint16 threshold;
        uint16 maxWallets;
        uint16 maxNftsPerWallet;
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

    struct RewardIndex {
        uint256 perWeight;
        mapping(bytes32 => uint256) debt;
    }

    struct NftRef {
        uint256 sourceChainId;
        address collection;
        uint256 tokenId;
    }

    struct Position {
        uint256 sourceChainId;
        address collection;
        uint32 weight;
        uint256 tokenId;
        address seatOwner;
        uint64 seatExpiry;
    }

    struct FundingConfig {
        address asset;
        uint128 budget;
        uint32 interval;
        uint16[] allocations;
    }

    struct FundingPlan {
        address asset;
        uint128 budget;
        uint32 interval;
        bool paused;
        uint128 deposited;
        uint128 spent;
        uint128 recovered;
    }

    struct FundingLane {
        uint16 allocationBps;
        uint128 spent;
        uint32 lastEpoch;
        bool purchased;
    }

    struct Pool {
        PoolConfig config;
        uint64 checkedUntil;
        uint16 activeWallets;
        uint16 activeNfts;
        uint64 totalWeight;
        CollectionRule[] collections;
        address[] rewardTokens;
        bytes32[] enrollmentHistory;
        bytes32[] remoteSeats;
        mapping(bytes32 => uint8) remoteSlot;
        mapping(address => bytes32[]) walletHistory;
        mapping(address => mapping(bytes32 => bool)) remembered;
        mapping(uint256 => mapping(address => uint32)) collectionWeights;
        mapping(address => Reward) rewards;
        mapping(address => RewardIndex) indexes;
        mapping(address => uint16) seatsByWallet;
        mapping(address => uint64) powerByWallet;
        mapping(bytes32 => Position) positions;
        mapping(bytes32 => mapping(address => uint256)) credits;
        FundingPlan funding;
        mapping(address => FundingLane) lanes;
        mapping(address => uint128) expiredRecovered;
        bool treasuryBacked;
        bool consolidated;
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
    error InvalidFundingPlan();
    error InvalidFundingEpoch();
    error FundingUnavailable();
    error InvalidDeadline();
    error ClaimPeriodEnded();
    error ClaimPeriodOpen();

    event PoolCreated(uint256 indexed poolId, uint64 start, uint64 end, string metadataURI);
    event RewardFunded(uint256 indexed poolId, address indexed token, address indexed funder, uint256 amount);
    event Joined(
        uint256 indexed poolId,
        bytes32 indexed nft,
        address indexed owner,
        uint256 sourceChainId,
        address collection,
        uint256 tokenId
    );
    event SeatChanged(uint256 indexed poolId, bytes32 indexed nft, address indexed owner);
    event Checkpoint(uint256 indexed poolId, uint64 checkedUntil, uint16 activeWallets, uint64 totalWeight);
    event Claimed(uint256 indexed poolId, bytes32 indexed nft, address indexed token, address owner, uint256 amount);
    event SurplusRecovered(uint256 indexed poolId, address indexed token, uint256 amount);
    event ExpiredRewardsRecovered(uint256 indexed poolId, address indexed token, uint256 amount);
    event FundingConfigured(uint256 indexed poolId, address indexed asset, uint128 budget, uint32 interval);
    event BudgetFunded(uint256 indexed poolId, address indexed asset, address indexed funder, uint256 amount);
    event FundingPaused(uint256 indexed poolId, bool paused);
    event Replenished(
        uint256 indexed poolId,
        address indexed token,
        uint32 indexed epoch,
        address executor,
        uint256 spent,
        uint256 received
    );
    event BudgetRecovered(uint256 indexed poolId, address indexed asset, uint256 amount);
    event TreasuryVaultAttached(address indexed vault);

    address public immutable admin;
    address public immutable treasury;
    address public immutable wrappedNative;
    RewardSwapAdapter public immutable swapAdapter;
    FinalizedOwnershipVerifier public immutable remoteVerifier;
    TreasuryVault public treasuryVault;
    uint256 public poolCount;
    mapping(address => bool) public supportedTokens;
    address[] private fundingAssets;
    mapping(uint256 => Pool) private pools;

    constructor(
        address poolAdmin,
        address surplusTreasury,
        address[] memory tokens,
        address wrapped,
        RewardSwapAdapter adapter,
        FinalizedOwnershipVerifier verifier
    ) {
        if ((block.chainid != SOURCE_CHAIN && block.chainid != 31337)
            || (address(verifier) != address(0) && (block.chainid != 31337 || address(verifier).code.length == 0))) {
            revert InvalidNetwork();
        }
        if (poolAdmin == address(0) || surplusTreasury == address(0) || tokens.length == 0 || tokens.length > 32) {
            revert InvalidConfiguration();
        }
        admin = poolAdmin;
        treasury = surplusTreasury;
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i].code.length == 0 || supportedTokens[tokens[i]]) revert InvalidToken();
            supportedTokens[tokens[i]] = true;
            fundingAssets.push(tokens[i]);
        }
        if (wrapped != address(0) && !supportedTokens[wrapped]) revert InvalidToken();
        if (address(adapter) != address(0) && (wrapped == address(0) || adapter.wrappedNative() != wrapped)) {
            revert InvalidConfiguration();
        }
        wrappedNative = wrapped;
        swapAdapter = adapter;
        remoteVerifier = verifier;
    }

    function createPool(PoolConfig calldata config, CollectionRule[] calldata collections, RewardConfig[] calldata rewards)
        external
        nonReentrant
        returns (uint256 poolId)
    {
        if (msg.sender != admin) revert Unauthorized();
        return _createPool(config, collections, rewards);
    }

    function createFundedPool(
        PoolConfig calldata config,
        CollectionRule[] calldata collections,
        RewardConfig[] calldata rewards,
        FundingConfig calldata funding
    ) external nonReentrant returns (uint256 poolId) {
        if (msg.sender != admin) revert Unauthorized();
        poolId = _createPool(config, collections, rewards);
        _configureFunding(poolId, funding.asset, funding.budget, funding.interval, funding.allocations);
    }

    /// @notice Only the immutable treasury authority can attach its vault, once.
    function attachTreasuryVault(TreasuryVault vault) external nonReentrant {
        if (msg.sender != treasury) revert Unauthorized();
        if (
            address(treasuryVault) != address(0) || address(vault.ledger()) != address(this)
                || vault.owner() != treasury || vault.wrappedNative() != wrappedNative
        ) revert InvalidConfiguration();
        treasuryVault = vault;
        emit TreasuryVaultAttached(address(vault));
    }

    function createTreasuryFundedPool(
        PoolConfig calldata config,
        CollectionRule[] calldata collections,
        RewardConfig[] calldata rewards,
        FundingConfig calldata funding,
        uint128 initialAllocation,
        bool consolidated
    ) external nonReentrant returns (uint256 poolId) {
        if (msg.sender != admin) revert Unauthorized();
        poolId = _createPool(config, collections, rewards);
        _configureFunding(poolId, funding.asset, funding.budget, funding.interval, funding.allocations);
        Pool storage pool = pools[poolId];
        pool.treasuryBacked = true;
        pool.consolidated = consolidated;
        _allocateTreasuryBudget(poolId, pool, initialAllocation);
    }

    function allocateTreasuryBudget(uint256 poolId, uint128 amount) external nonReentrant {
        if (msg.sender != admin) revert Unauthorized();
        Pool storage pool = _pool(poolId);
        if (!pool.treasuryBacked) revert InvalidFundingPlan();
        _allocateTreasuryBudget(poolId, pool, amount);
    }

    function treasuryFunding(uint256 poolId) external view returns (bool treasuryBacked, bool consolidated) {
        Pool storage pool = _pool(poolId);
        return (pool.treasuryBacked, pool.consolidated);
    }

    function _allocateTreasuryBudget(uint256 poolId, Pool storage pool, uint128 amount) private {
        FundingPlan storage plan = pool.funding;
        if (
            address(treasuryVault) == address(0) || amount == 0 || amount > plan.budget - plan.deposited
                || block.timestamp >= pool.config.end
        ) revert FundingUnavailable();
        IERC20 asset = IERC20(plan.asset);
        uint256 beforeBalance = asset.balanceOf(address(this));
        plan.deposited += amount;
        treasuryVault.allocate(poolId, plan.asset, amount);
        if (asset.balanceOf(address(this)) != beforeBalance + amount) revert InvalidReceipt();
        emit BudgetFunded(poolId, plan.asset, address(treasuryVault), amount);
    }

    function supportedAssets() external view returns (address[] memory) {
        return fundingAssets;
    }

    function _createPool(PoolConfig calldata config, CollectionRule[] calldata collections, RewardConfig[] calldata rewards)
        private returns (uint256 poolId)
    {
        if (
            config.start < block.timestamp || config.end <= config.start || config.end - config.start > 4 * 365 days
                || config.maxWallets == 0 || config.threshold > config.maxWallets || config.maxNftsPerWallet == 0
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
                rule.collection == address(0) || rule.weight == 0 || rule.weight > MAX_WEIGHT
                    || pool.collectionWeights[rule.sourceChainId][rule.collection] != 0
                    || !_supportsCollection(rule.sourceChainId, rule.collection)
            ) revert InvalidConfiguration();
            pool.collections.push(rule);
            pool.collectionWeights[rule.sourceChainId][rule.collection] = rule.weight;
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
        returns (PoolConfig memory config, uint64 checkedUntil, uint16 activeWallets, uint64 totalWeight, uint256 activeNfts)
    {
        Pool storage pool = _pool(poolId);
        return (pool.config, pool.checkedUntil, pool.activeWallets, pool.totalWeight, pool.activeNfts);
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

    /// @notice Aggregate reserved credits in scaled units, including unsettled earnings.
    /// Per-NFT payouts round down independently to whole ERC-20 base units.
    function rewardSettlement(uint256 poolId, address token)
        external view returns (uint256 claimLiability, uint128 expiredRecovered)
    {
        Pool storage pool = _pool(poolId);
        Reward storage reward = pool.rewards[token];
        expiredRecovered = pool.expiredRecovered[token];
        if (_claimPeriodEnded(pool)) return (0, expiredRecovered);
        claimLiability = reward.committed + _indexDelta(pool, reward, _previewThrough(pool)) * pool.totalWeight;
    }

    function positionState(uint256 poolId, bytes32 key) external view returns (Position memory) {
        return _pool(poolId).positions[key];
    }

    /// @notice Paged enrollment history includes expired and departed positions that may still hold credits.
    function positionKeys(uint256 poolId, uint256 offset, uint256 limit)
        external view returns (bytes32[] memory keys, uint256 total)
    {
        return _page(_pool(poolId).enrollmentHistory, offset, limit);
    }

    /// @notice Positions observed for this wallet. Check current ERC-721 ownership before paying.
    function walletPositionKeys(uint256 poolId, address account, uint256 offset, uint256 limit)
        external view returns (bytes32[] memory keys, uint256 total)
    {
        return _page(_pool(poolId).walletHistory[account], offset, limit);
    }

    function _page(bytes32[] storage history, uint256 offset, uint256 limit)
        private view returns (bytes32[] memory keys, uint256 total)
    {
        if (limit == 0 || limit > MAX_BATCH) revert InvalidConfiguration();
        total = history.length;
        if (offset >= total) return (new bytes32[](0), total);
        uint256 length = total - offset;
        if (length > limit) length = limit;
        keys = new bytes32[](length);
        for (uint256 i; i < length; ++i) keys[i] = history[offset + i];
    }

    function walletsNftCount(uint256 poolId, address account) external view returns (uint256) {
        return _pool(poolId).seatsByWallet[account];
    }

    function walletPositionStats(uint256 poolId, address account) external view returns (uint16 count, uint64 power) {
        Pool storage pool = _pool(poolId);
        return (pool.seatsByWallet[account], pool.powerByWallet[account]);
    }

    /// @notice Credits follow the NFT key. An overdue remote proof is a conservative preview boundary.
    function claimable(uint256 poolId, bytes32 key, address token) external view returns (uint256) {
        Pool storage pool = _pool(poolId);
        if (_claimPeriodEnded(pool)) return 0;
        uint256 credit = pool.credits[key][token];
        Position storage position = pool.positions[key];
        if (position.seatOwner != address(0)) {
            Reward storage reward = pool.rewards[token];
            RewardIndex storage index = pool.indexes[token];
            uint256 current = index.perWeight + _indexDelta(pool, reward, _previewThrough(pool));
            credit += (current - index.debt[key]) * position.weight;
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

    /// @notice One funding asset and fixed splits. A WPOL plan also accepts native POL deposits.
    function configureFunding(uint256 poolId, address asset, uint128 budget, uint32 interval, uint16[] calldata splits)
        external nonReentrant
    {
        if (msg.sender != admin) revert Unauthorized();
        _configureFunding(poolId, asset, budget, interval, splits);
    }

    function _configureFunding(uint256 poolId, address asset, uint128 budget, uint32 interval, uint16[] calldata splits)
        private
    {
        Pool storage pool = _pool(poolId);
        if (
            pool.funding.asset != address(0) || !supportedTokens[asset] || budget == 0
                || block.timestamp >= pool.config.start || interval < MIN_REPLENISH_INTERVAL
                || interval > MAX_REPLENISH_INTERVAL || interval > pool.config.end - pool.config.start
                || splits.length != pool.rewardTokens.length
        ) revert InvalidFundingPlan();

        uint256 sum;
        for (uint256 i; i < splits.length; ++i) {
            address token = pool.rewardTokens[i];
            if (splits[i] == 0 || uint256(budget) * splits[i] / BPS == 0) revert InvalidFundingPlan();
            if (token != asset && address(swapAdapter) == address(0)) revert InvalidFundingPlan();
            sum += splits[i];
            pool.lanes[token].allocationBps = splits[i];
        }
        if (sum != BPS) revert InvalidFundingPlan();
        pool.funding.asset = asset;
        pool.funding.budget = budget;
        pool.funding.interval = interval;
        emit FundingConfigured(poolId, asset, budget, interval);
    }

    function fundingState(uint256 poolId) external view returns (FundingPlan memory) {
        return _pool(poolId).funding;
    }

    function fundingLane(uint256 poolId, address rewardToken) external view returns (FundingLane memory) {
        return _pool(poolId).lanes[rewardToken];
    }

    function setFundingPaused(uint256 poolId, bool paused) external nonReentrant {
        if (msg.sender != admin) revert Unauthorized();
        Pool storage pool = _pool(poolId);
        if (pool.funding.asset == address(0)) revert InvalidFundingPlan();
        pool.funding.paused = paused;
        emit FundingPaused(poolId, paused);
    }

    function fundBudget(uint256 poolId, uint128 amount) external payable nonReentrant {
        Pool storage pool = _pool(poolId);
        FundingPlan storage plan = pool.funding;
        if (
            pool.treasuryBacked || plan.asset == address(0) || amount == 0 || amount > plan.budget - plan.deposited
                || block.timestamp >= pool.config.end
        ) revert FundingUnavailable();

        IERC20 asset = IERC20(plan.asset);
        uint256 beforeBalance = asset.balanceOf(address(this));
        if (msg.value == 0) {
            asset.safeTransferFrom(msg.sender, address(this), amount);
        } else {
            if (msg.value != amount || plan.asset != wrappedNative) revert InvalidFundingPlan();
            IWrappedNative(wrappedNative).deposit{value: amount}();
        }
        if (asset.balanceOf(address(this)) - beforeBalance != amount) revert InvalidReceipt();
        plan.deposited += amount;
        emit BudgetFunded(poolId, address(asset), msg.sender, amount);
    }

    /// @return epoch Current purchase window. Epoch zero is available for a pre-start purchase.
    /// @return amount Maximum input this window if projected inventory needs replenishment.
    /// @return target Reward inventory desired for the next interval, in reward base units.
    function nextReplenishment(uint256 poolId, address rewardToken)
        external view returns (uint32 epoch, uint256 amount, uint256 target)
    {
        Pool storage pool = _pool(poolId);
        Reward storage reward = pool.rewards[rewardToken];
        uint256 available = _available(reward) - _indexDelta(pool, reward, _previewThrough(pool)) * pool.totalWeight;
        return _replenishment(pool, rewardToken, available);
    }

    function replenish(uint256 poolId, address rewardToken, uint32 expectedEpoch, uint256 minimum, uint256 deadline)
        external nonReentrant returns (uint256 received)
    {
        if (deadline < block.timestamp || deadline - block.timestamp > MAX_REPLENISH_DEADLINE) {
            revert InvalidDeadline();
        }
        Pool storage pool = _pool(poolId);
        Reward storage reward = pool.rewards[rewardToken];
        _settle(poolId, pool);
        (uint32 epoch, uint256 amount,) = _replenishment(pool, rewardToken, _available(reward));
        if (epoch != expectedEpoch) revert InvalidFundingEpoch();
        if (amount == 0) revert FundingUnavailable();

        FundingPlan storage plan = pool.funding;
        FundingLane storage lane = pool.lanes[rewardToken];
        lane.lastEpoch = epoch;
        lane.purchased = true;
        lane.spent += uint128(amount);
        plan.spent += uint128(amount);
        if (pool.treasuryBacked) treasuryVault.recordSpend(poolId, plan.asset, amount);

        received = amount;
        if (plan.asset != rewardToken) {
            IERC20 source = IERC20(plan.asset);
            IERC20 output = IERC20(rewardToken);
            uint256 inputBefore = source.balanceOf(address(this));
            uint256 outputBefore = output.balanceOf(address(this));
            source.forceApprove(address(swapAdapter), amount);
            received = swapAdapter.swapExact(plan.asset, rewardToken, amount, minimum, deadline);
            source.forceApprove(address(swapAdapter), 0);
            if (
                inputBefore - source.balanceOf(address(this)) != amount
                    || output.balanceOf(address(this)) - outputBefore != received
            ) revert InvalidReceipt();
        }
        if (received == 0 || received < minimum || received > type(uint128).max - reward.inventory) {
            revert InvalidReceipt();
        }
        reward.inventory += uint128(received);
        emit Replenished(poolId, rewardToken, epoch, msg.sender, amount, received);
    }

    function recoverBudget(uint256 poolId) external nonReentrant returns (uint256 amount) {
        Pool storage pool = _pool(poolId);
        if (block.timestamp < pool.config.end) revert PoolNotEnded();
        FundingPlan storage plan = pool.funding;
        if (plan.asset == address(0)) revert InvalidFundingPlan();
        amount = plan.deposited - plan.spent - plan.recovered;
        if (amount != 0) {
            plan.recovered += uint128(amount);
            _returnToTreasury(poolId, pool, plan.asset, amount, false);
            emit BudgetRecovered(poolId, plan.asset, amount);
        }
    }

    function join(uint256 poolId, uint256 sourceChainId, address collection, uint256 tokenId) external nonReentrant {
        Pool storage pool = _prepareJoin(poolId);
        _join(poolId, pool, sourceChainId, collection, tokenId);
    }

    function joinBatch(uint256 poolId, NftRef[] calldata nfts) external nonReentrant {
        if (nfts.length == 0 || nfts.length > MAX_BATCH) revert InvalidConfiguration();
        Pool storage pool = _prepareJoin(poolId);
        for (uint256 i; i < nfts.length; ++i) {
            _join(poolId, pool, nfts[i].sourceChainId, nfts[i].collection, nfts[i].tokenId);
        }
    }

    function _prepareJoin(uint256 poolId) private returns (Pool storage pool) {
        pool = _pool(poolId);
        if (block.timestamp < pool.config.start || block.timestamp >= pool.config.end) revert UnavailablePool();
        _settle(poolId, pool);
    }

    function _join(uint256 poolId, Pool storage pool, uint256 sourceChainId, address collection, uint256 tokenId) private {
        uint32 weight = pool.collectionWeights[sourceChainId][collection];
        if (weight == 0) revert NotCurrentOwner();
        (address owner, uint64 expiry) = _qualifiedOwner(sourceChainId, collection, tokenId);
        if (owner != msg.sender) revert NotCurrentOwner();
        bytes32 key = nftKey(sourceChainId, collection, tokenId);
        Position storage position = pool.positions[key];
        if (position.seatOwner == owner) revert AlreadyEnrolled();
        if (position.seatOwner != address(0)) _detach(pool, key, position);
        if (!_canSeat(pool, owner, expiry)) revert NoSeatAvailable();
        if (position.collection == address(0)) {
            pool.enrollmentHistory.push(key);
            position.sourceChainId = sourceChainId;
            position.collection = collection;
            position.tokenId = tokenId;
            position.weight = weight;
        }
        _attach(pool, key, position, owner, expiry);
        emit Joined(poolId, key, msg.sender, sourceChainId, collection, tokenId);
    }

    /// @notice Advance reward indexes. Ownership reconciliation is scoped to the submitted keys.
    function checkpoint(uint256 poolId) external nonReentrant {
        Pool storage pool = _pool(poolId);
        _settle(poolId, pool);
    }

    function reconcile(uint256 poolId, bytes32[] calldata keys) external nonReentrant {
        if (keys.length == 0 || keys.length > MAX_BATCH) revert InvalidConfiguration();
        Pool storage pool = _pool(poolId);
        _settle(poolId, pool);
        for (uint256 i; i < keys.length; ++i) {
            bytes32 key = keys[i];
            Position storage position = pool.positions[key];
            if (position.collection == address(0)) revert NotEnrolled();
            (address owner, uint64 expiry) = _qualifiedOwner(position.sourceChainId, position.collection, position.tokenId);
            _reconcileSeat(poolId, pool, key, position, owner, expiry);
        }
    }

    function claim(uint256 poolId, uint256 sourceChainId, address collection, uint256 tokenId) external nonReentrant {
        (Pool storage pool, bytes32 key) = _ownedPosition(poolId, sourceChainId, collection, tokenId, true);
        for (uint256 i; i < pool.rewardTokens.length; ++i) _pay(poolId, pool, key, pool.rewardTokens[i]);
    }

    /// @notice A single-token claim stays useful if another reward token is paused.
    function claimReward(
        uint256 poolId, uint256 sourceChainId, address collection, uint256 tokenId, address rewardToken
    ) external nonReentrant {
        (Pool storage pool, bytes32 key) = _ownedPosition(poolId, sourceChainId, collection, tokenId, true);
        if (pool.rewards[rewardToken].cap == 0) revert InvalidToken();
        _pay(poolId, pool, key, rewardToken);
    }

    function exit(uint256 poolId, uint256 sourceChainId, address collection, uint256 tokenId) external nonReentrant {
        (Pool storage pool, bytes32 key) = _ownedPosition(poolId, sourceChainId, collection, tokenId, true);
        _leave(poolId, pool, key);
        for (uint256 i; i < pool.rewardTokens.length; ++i) _pay(poolId, pool, key, pool.rewardTokens[i]);
    }

    /// @notice Releases the seat without transferring rewards. Preserves any unexpired claims.
    function leave(uint256 poolId, uint256 sourceChainId, address collection, uint256 tokenId) external nonReentrant {
        (Pool storage pool, bytes32 key) = _ownedPosition(poolId, sourceChainId, collection, tokenId, false);
        _leave(poolId, pool, key);
    }

    function recoverSurplus(uint256 poolId, address token) external nonReentrant returns (uint256 amount) {
        Pool storage pool = _pool(poolId);
        if (block.timestamp < pool.config.end) revert PoolNotEnded();
        Reward storage reward = pool.rewards[token];
        if (reward.cap == 0) revert InvalidToken();
        if (_claimPeriodEnded(pool)) return _recoverExpiredRewards(poolId, pool, reward, token);
        _settle(poolId, pool);
        amount = _available(reward) / PRECISION;
        reward.inventory -= uint128(amount);
        if (amount != 0) {
            _returnToTreasury(poolId, pool, token, amount, true);
            emit SurplusRecovered(poolId, token, amount);
        }
    }

    /// @notice Anyone may settle one expired reward token to the immutable treasury.
    function recoverExpiredRewards(uint256 poolId, address token) external nonReentrant returns (uint256 amount) {
        Pool storage pool = _pool(poolId);
        if (!_claimPeriodEnded(pool)) revert ClaimPeriodOpen();
        Reward storage reward = pool.rewards[token];
        if (reward.cap == 0) revert InvalidToken();
        return _recoverExpiredRewards(poolId, pool, reward, token);
    }

    function _recoverExpiredRewards(uint256 poolId, Pool storage pool, Reward storage reward, address token)
        private returns (uint256 amount)
    {
        amount = reward.inventory;
        reward.committed = 0;
        if (amount != 0) {
            reward.inventory = 0;
            pool.expiredRecovered[token] = uint128(amount);
            _returnToTreasury(poolId, pool, token, amount, true);
            emit ExpiredRewardsRecovered(poolId, token, amount);
        }
    }

    function _returnToTreasury(uint256 poolId, Pool storage pool, address token, uint256 amount, bool reward)
        private
    {
        if (pool.treasuryBacked) {
            _transferExact(token, address(treasuryVault), amount);
            treasuryVault.recordRecovery(poolId, token, amount, reward);
        } else {
            _transferExact(token, treasury, amount);
        }
    }

    function _pool(uint256 poolId) private view returns (Pool storage pool) {
        if (poolId == 0 || poolId > poolCount) revert UnavailablePool();
        return pools[poolId];
    }

    function _ownedPosition(uint256 poolId, uint256 sourceChainId, address collection, uint256 tokenId, bool paysRewards)
        private
        returns (Pool storage pool, bytes32 key)
    {
        pool = _pool(poolId);
        if (paysRewards && _claimPeriodEnded(pool)) revert ClaimPeriodEnded();
        key = nftKey(sourceChainId, collection, tokenId);
        Position storage position = pool.positions[key];
        if (position.collection == address(0)) revert NotEnrolled();
        (address owner, uint64 expiry) = _qualifiedOwner(sourceChainId, collection, tokenId);
        if (owner != msg.sender) revert NotCurrentOwner();
        _settle(poolId, pool);
        _reconcileSeat(poolId, pool, key, position, owner, expiry);
    }

    function _supportsCollection(uint256 sourceChainId, address collection) private view returns (bool) {
        if (sourceChainId != SOURCE_CHAIN) {
            return address(remoteVerifier) != address(0) && remoteVerifier.supportsSource(sourceChainId);
        }
        return _isErc721(collection);
    }

    function _qualifiedOwner(uint256 sourceChainId, address collection, uint256 tokenId)
        private view returns (address owner, uint64 expiry)
    {
        if (sourceChainId == SOURCE_CHAIN) return (_ownerOf(collection, tokenId), 0);
        if (address(remoteVerifier) == address(0)) return (address(0), 0);
        return remoteVerifier.freshOwner(sourceChainId, collection, tokenId);
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

    function _claimPeriodEnded(Pool storage pool) private view returns (bool) {
        return block.timestamp >= uint256(pool.config.end) + CLAIM_PERIOD;
    }

    function _available(Reward storage reward) private view returns (uint256) {
        return uint256(reward.inventory) * PRECISION - reward.committed;
    }

    function _replenishment(Pool storage pool, address token, uint256 available)
        private view returns (uint32 epoch, uint256 amount, uint256 target)
    {
        FundingPlan storage plan = pool.funding;
        FundingLane storage lane = pool.lanes[token];
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

    function _indexDelta(Pool storage pool, Reward storage reward, uint64 through) private view returns (uint256) {
        if (pool.totalWeight == 0) return 0;
        return _intervalEmission(pool, reward, through) / pool.totalWeight;
    }

    function _nextExpiry(Pool storage pool, uint64 through) private view returns (uint8 slot, uint64 expiry) {
        expiry = through;
        // Polygon seats never enter this bounded list. Remote proofs exist only in the isolated verifier.
        for (uint8 i; i < pool.remoteSeats.length; ++i) {
            uint64 candidate = pool.positions[pool.remoteSeats[i]].seatExpiry;
            if (candidate <= expiry) (slot, expiry) = (i + 1, candidate);
        }
    }

    function _previewThrough(Pool storage pool) private view returns (uint64 through) {
        (, through) = _nextExpiry(pool, _through(pool));
    }

    function _settle(uint256 poolId, Pool storage pool) private {
        uint64 through = _through(pool);
        if (through <= pool.checkedUntil) return;
        if (_claimPeriodEnded(pool)) {
            pool.checkedUntil = through;
        } else {
            (uint8 slot, uint64 expiry) = _nextExpiry(pool, through);
            while (slot != 0) {
                _advance(pool, expiry);
                _leave(poolId, pool, pool.remoteSeats[slot - 1]);
                (slot, expiry) = _nextExpiry(pool, through);
            }
            _advance(pool, through);
        }
        emit Checkpoint(poolId, through, pool.activeWallets, pool.totalWeight);
    }

    function _advance(Pool storage pool, uint64 through) private {
        if (through <= pool.checkedUntil) return;
        for (uint256 i; i < pool.rewardTokens.length; ++i) {
            address token = pool.rewardTokens[i];
            Reward storage reward = pool.rewards[token];
            uint256 delta = _indexDelta(pool, reward, through);
            if (delta == 0) continue;
            pool.indexes[token].perWeight += delta;
            // Reserve exactly the credits represented by the increment. Index dust remains uncommitted.
            reward.committed += delta * pool.totalWeight;
        }
        pool.checkedUntil = through;
    }

    function _accrue(Pool storage pool, bytes32 key, uint32 weight, address token) private {
        RewardIndex storage index = pool.indexes[token];
        uint256 current = index.perWeight;
        uint256 previous = index.debt[key];
        if (current != previous) {
            pool.credits[key][token] += (current - previous) * weight;
            index.debt[key] = current;
        }
    }

    function _remember(Pool storage pool, address owner, bytes32 key) private {
        if (!pool.remembered[owner][key]) {
            pool.remembered[owner][key] = true;
            pool.walletHistory[owner].push(key);
        }
    }

    function _reconcileSeat(
        uint256 poolId, Pool storage pool, bytes32 key, Position storage position, address owner, uint64 expiry
    ) private {
        if (owner != address(0)) _remember(pool, owner, key);
        if (block.timestamp >= pool.config.end || position.seatOwner == address(0)) return;
        if (owner == position.seatOwner) {
            if (position.seatExpiry != expiry) position.seatExpiry = expiry;
            return;
        }
        _detach(pool, key, position);
        if (owner != address(0) && _canSeat(pool, owner, expiry)) _attach(pool, key, position, owner, expiry);
        emit SeatChanged(poolId, key, position.seatOwner);
    }

    function _canSeat(Pool storage pool, address owner, uint64 expiry) private view returns (bool) {
        uint256 count = pool.seatsByWallet[owner];
        return pool.activeNfts < MAX_POSITIONS && (expiry == 0 || pool.remoteSeats.length < MAX_REMOTE_POSITIONS)
            && count < pool.config.maxNftsPerWallet && (count != 0 || pool.activeWallets < pool.config.maxWallets);
    }

    function _attach(Pool storage pool, bytes32 key, Position storage position, address owner, uint64 expiry) private {
        if (pool.seatsByWallet[owner]++ == 0) ++pool.activeWallets;
        ++pool.activeNfts;
        pool.totalWeight += position.weight;
        pool.powerByWallet[owner] += position.weight;
        position.seatOwner = owner;
        position.seatExpiry = expiry;
        if (expiry != 0) {
            pool.remoteSeats.push(key);
            pool.remoteSlot[key] = uint8(pool.remoteSeats.length);
        }
        for (uint256 i; i < pool.rewardTokens.length; ++i) {
            RewardIndex storage index = pool.indexes[pool.rewardTokens[i]];
            if (index.debt[key] != index.perWeight) index.debt[key] = index.perWeight;
        }
        _remember(pool, owner, key);
    }

    function _detach(Pool storage pool, bytes32 key, Position storage position) private {
        if (!_claimPeriodEnded(pool)) {
            for (uint256 i; i < pool.rewardTokens.length; ++i) {
                _accrue(pool, key, position.weight, pool.rewardTokens[i]);
            }
        }
        if (--pool.seatsByWallet[position.seatOwner] == 0) --pool.activeWallets;
        pool.powerByWallet[position.seatOwner] -= position.weight;
        --pool.activeNfts;
        pool.totalWeight -= position.weight;
        position.seatOwner = address(0);
        if (position.seatExpiry != 0) {
            position.seatExpiry = 0;
            uint8 slot = pool.remoteSlot[key];
            bytes32 last = pool.remoteSeats[pool.remoteSeats.length - 1];
            pool.remoteSeats[slot - 1] = last;
            pool.remoteSlot[last] = slot;
            pool.remoteSeats.pop();
            delete pool.remoteSlot[key];
        }
    }

    function _leave(uint256 poolId, Pool storage pool, bytes32 key) private {
        Position storage position = pool.positions[key];
        if (position.seatOwner == address(0)) return;
        _detach(pool, key, position);
        emit SeatChanged(poolId, key, address(0));
    }

    function _pay(uint256 poolId, Pool storage pool, bytes32 key, address token) private {
        Reward storage reward = pool.rewards[token];
        Position storage position = pool.positions[key];
        if (position.seatOwner != address(0)) _accrue(pool, key, position.weight, token);
        uint256 scaled = pool.credits[key][token];
        uint256 amount = scaled / PRECISION;
        uint256 consumed = block.timestamp >= pool.config.end ? scaled : amount * PRECISION;
        pool.credits[key][token] = scaled - consumed;
        reward.committed -= consumed;
        if (amount != 0) {
            // Revalidate after each previous reward token call in a multi-token payout.
            (address owner,) = _qualifiedOwner(position.sourceChainId, position.collection, position.tokenId);
            if (owner != msg.sender) revert NotCurrentOwner();
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
