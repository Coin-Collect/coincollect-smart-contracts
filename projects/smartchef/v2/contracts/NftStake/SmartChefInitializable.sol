// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
pragma abicoder v2;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableMap} from "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

interface IERC721Enumerable {
    function totalSupply() external view returns (uint256);
}

contract SmartChefInitializable is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;
    using EnumerableMap for EnumerableMap.UintToAddressMap;
    using EnumerableSet for EnumerableSet.UintSet;

    // The address of the smart chef factory
    address public immutable SMART_CHEF_FACTORY;

    // Whether a limit is set for users
    bool public userLimit;

    // Whether it is initialized
    bool public isInitialized;

    // Accrued token per share
    uint256 public accTokenPerShare;

    // The block number at which the staking period ends
    uint256 public bonusEndBlock;

    // The block number at which the staking period starts
    uint256 public startBlock;

    // The block number of the last pool update
    uint256 public lastRewardBlock;

    // The pool limit (0 if none)
    uint256 public poolLimitPerUser;

    // Block numbers available for user limit (after start block)
    uint256 public numberBlocksForUserLimit;

    // Reward tokens created per block.
    uint256 public rewardPerBlock;

    // The precision factor
    uint256 public PRECISION_FACTOR;

    // The reward token
    IERC20Metadata public rewardToken;

    // The staked token
    IERC721 public stakedToken;

    // User capacity to stake simultaneously
    uint256 public poolCapacity;

    // When participants are below this threshold, rewards are divided by participant threshold
    uint256 public participantThreshold;

    bool public isSideRewardActive;
    IERC20Metadata[] public sideRewardTokens;
    mapping(address => uint256) public sideRewardPercentage;
    mapping(address => uint256) public rewardTokenDecimals;

    // Variables for NFT Stake
    mapping(address => EnumerableSet.UintSet) holderTokens;
    EnumerableMap.UintToAddressMap tokenOwners;

    // Info of each user that stakes tokens (stakedToken)
    mapping(address => UserInfo) public userInfo;

    struct UserInfo {
        uint256 amount; // How many staked tokens the user has provided
        uint256 rewardDebt; // Reward debt
    }

    struct ConfigExtra {
        uint256 poolCapacity;
        uint256 participantThreshold;
    }

    event Deposit(address indexed user, uint256 tokenId);
    event EmergencyWithdraw(address indexed user, uint256 amount);
    event NewStartAndEndBlocks(uint256 startBlock, uint256 endBlock);
    event NewRewardPerBlock(uint256 rewardPerBlock);
    event NewPoolLimit(uint256 poolLimitPerUser);
    event RewardsStop(uint256 blockNumber);
    event TokenRecovery(address indexed token, uint256 amount);
    event Harvest(address indexed user, uint256 amount);
    event Withdraw(address indexed user, uint256 tokenId);
    

    constructor() {
        SMART_CHEF_FACTORY = msg.sender;
    }

    /**
     * @notice Initialize the contract
     * @param _stakedToken: staked token address
     * @param _rewardToken: reward token address
     * @param _rewardPerBlock: reward per block (in rewardToken)
     * @param _startBlock: start block
     * @param _bonusEndBlock: end block
     * @param _poolLimitPerUser: pool limit per user in stakedToken (if any, else 0)
     * @param _numberBlocksForUserLimit: block numbers available for user limit (after start block)
     * @param _configExtra: Additional configuration parameters
     * @param _admin: admin address with ownership
     */
    function initialize(
        IERC721 _stakedToken,
        IERC20Metadata _rewardToken,
        IERC20Metadata[] memory _sideRewardTokens,
        uint256[] memory _sideRewardPercentage,
        uint256 _rewardPerBlock,
        uint256 _startBlock,
        uint256 _bonusEndBlock,
        uint256 _poolLimitPerUser,
        uint256 _numberBlocksForUserLimit,
        ConfigExtra memory _configExtra,
        address _admin
    ) external {
        require(!isInitialized, "Already initialized");
        require(msg.sender == SMART_CHEF_FACTORY, "Not factory");

        // Make this contract initialized
        isInitialized = true;

        stakedToken = _stakedToken;
        rewardToken = _rewardToken;
        rewardPerBlock = _rewardPerBlock;
        startBlock = _startBlock;
        bonusEndBlock = _bonusEndBlock;
        poolCapacity = _configExtra.poolCapacity;
        participantThreshold = _configExtra.participantThreshold;

        if (_poolLimitPerUser > 0) {
            userLimit = true;
            poolLimitPerUser = _poolLimitPerUser;
            numberBlocksForUserLimit = _numberBlocksForUserLimit;
        }

        uint256 decimalsRewardToken = uint256(rewardToken.decimals());
        require(decimalsRewardToken < 30, "Must be inferior to 30");

        rewardTokenDecimals[address(_rewardToken)] = decimalsRewardToken;
        if (_sideRewardTokens.length > 0) {
            isSideRewardActive = true;
            sideRewardTokens = _sideRewardTokens;
            for (uint i = 0; i < sideRewardTokens.length; i ++) {
                IERC20Metadata sideRewardToken = sideRewardTokens[i];
                sideRewardPercentage[address(sideRewardToken)] = _sideRewardPercentage[i];
                uint256 decimalsSideRewardToken = uint256(sideRewardToken.decimals());
                rewardTokenDecimals[address(sideRewardToken)] = decimalsSideRewardToken;
            }

        }

        PRECISION_FACTOR = uint256(10**(uint256(30) - decimalsRewardToken));

        // Set the lastRewardBlock as the startBlock
        lastRewardBlock = startBlock;

        // Transfer ownership to the admin address who becomes owner of the contract
        transferOwnership(_admin);
    }

    /**
     * @notice Deposit staked tokens and collect reward tokens (if any)
     * @param _tokenId: id of nft to deposit
     */
    function deposit(uint256 _tokenId) public nonReentrant {
        UserInfo storage user = userInfo[msg.sender];

        userLimit = hasUserLimit();

        require(!userLimit || ((user.amount + 1) <= poolLimitPerUser), "Deposit: Amount above limit");

        _updatePool();

        if (user.amount > 0) {
            uint256 pending = (user.amount * accTokenPerShare) / PRECISION_FACTOR - user.rewardDebt;
            if (pending > 0) {
                rewardToken.safeTransfer(address(msg.sender), pending);
                distributeSideRewards(pending);
            }
        }

        // User deposit first time, new staker
        if (user.amount == 0) {
            require(poolCapacity > 0, "pool is out of capacity");
            poolCapacity = poolCapacity - 1;
        }

        
        user.amount = user.amount + 1;
        stakedToken.transferFrom(address(msg.sender), address(this), _tokenId);

        holderTokens[msg.sender].add(_tokenId);
        tokenOwners.set(_tokenId, msg.sender);

        user.rewardDebt = (user.amount * accTokenPerShare) / PRECISION_FACTOR;

        emit Deposit(msg.sender, _tokenId);
    }

    /**
     * @notice Collect reward tokens (if any)
     */
    function harvest() external nonReentrant {
        UserInfo storage user = userInfo[msg.sender];
        _updatePool();

        uint256 pending = 0;
        if (user.amount > 0) {
            pending = (user.amount * accTokenPerShare) / PRECISION_FACTOR - user.rewardDebt;
            if (pending > 0) {
                rewardToken.safeTransfer(address(msg.sender), pending);
                distributeSideRewards(pending);
            }
        }

        user.rewardDebt = (user.amount * accTokenPerShare) / PRECISION_FACTOR;
        emit Harvest(msg.sender, pending);
    }

    /**
     * @notice Withdraw staked tokens and collect reward tokens
     * @param _tokenId: id of nft to withdraw
     */
    function withdraw(uint256 _tokenId) public nonReentrant {
        require(tokenOwners.get(_tokenId) == msg.sender, "illegal tokenId");

        UserInfo storage user = userInfo[msg.sender];

        _updatePool();

        uint256 pending = (user.amount * accTokenPerShare) / PRECISION_FACTOR - user.rewardDebt;
        if (pending > 0) {
            rewardToken.safeTransfer(address(msg.sender), pending);
            distributeSideRewards(pending);
        }

        user.amount = user.amount - 1;
        stakedToken.transferFrom(address(this), address(msg.sender), _tokenId);
        tokenOwners.remove(_tokenId);
        holderTokens[msg.sender].remove(_tokenId);
        
        // User leaves the pool, add capacity
        if(user.amount == 0) {
            poolCapacity = poolCapacity + 1;
        }

        user.rewardDebt = (user.amount * accTokenPerShare) / PRECISION_FACTOR;

        emit Withdraw(msg.sender, _tokenId);
    }

    /**
    * @notice Distribute side rewards to the caller based on the specified percentages
    * @param _pending The pending amount to be distributed according to side reward percentage
    */
    function distributeSideRewards(uint256 _pending) internal {
        if (isSideRewardActive) {
            for (uint i = 0; i < sideRewardTokens.length; i ++) {
                IERC20Metadata sideRewardToken = sideRewardTokens[i];
                // Add sideReward with specific percentage of pending amount.
                uint256 sideReward = (_pending * sideRewardPercentage[address(sideRewardToken)]) / 100;

                if (rewardTokenDecimals[address(sideRewardToken)] > rewardTokenDecimals[address(rewardToken)]) {
                    sideReward = sideReward * 10 ** (rewardTokenDecimals[address(sideRewardToken)] - rewardTokenDecimals[address(rewardToken)]);
                } else if (rewardTokenDecimals[address(sideRewardToken)] < rewardTokenDecimals[address(rewardToken)]) {
                    sideReward = sideReward / 10 ** (rewardTokenDecimals[address(rewardToken)] - rewardTokenDecimals[address(sideRewardToken)]);
                }

                sideRewardToken.safeTransfer(address(msg.sender), sideReward);
            }
        }
    }

    /**
     * @notice Stakes all the specified tokens
     * @param _tokenIds: an array of token IDs to be staked
     * @dev This function allows the user to stake multiple tokens at once
     */
    function stakeAll(uint256[] memory _tokenIds) external {
        for (uint i = 0; i < _tokenIds.length; i ++) {
            deposit(_tokenIds[i]);
        }
    }

    /**
     * @notice Unstakes all the specified tokens
     * @param _tokenIds: an array of token IDs to be unstaked
     * @dev This function allows the user to unstake multiple tokens at once
     */
    function unstakeAll(uint256[] memory _tokenIds) external {
        for (uint i = 0; i < _tokenIds.length; i ++) {
            withdraw(_tokenIds[i]);
        }
    }

    /**
     * @notice Returns the balance of tokens owned by the specified address
     * @param owner: the address to query the token balance for
     * @return The number of tokens owned by the address
     */
    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "ERC721: balance query for the zero address");
        return holderTokens[owner].length();
    }

    /**
     * @notice Returns the token ID owned by the specified address at the specified index
     * @param owner: the address of the token owner
     * @param index: the index of the token to retrieve
     * @return The token ID at the specified index owned by the address
     */
    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256) {
        return holderTokens[owner].at(index);
    }

    /**
     * @notice Withdraw staked tokens without caring about rewards rewards
     * @dev Needs to be for emergency.
     */
    function emergencyWithdraw() external nonReentrant {
        UserInfo storage user = userInfo[msg.sender];
        uint256 amountToTransfer = user.amount;
        user.amount = 0;
        user.rewardDebt = 0;

        if (amountToTransfer > 0) {
            for (uint i = 0; i < amountToTransfer; i ++) {
                uint256 tokenId = holderTokens[msg.sender].at(i);
                stakedToken.transferFrom(address(this), address(msg.sender), tokenId);
                tokenOwners.remove(tokenId);
                holderTokens[msg.sender].remove(tokenId);
            }
            poolCapacity = poolCapacity + 1;
        }

        emit EmergencyWithdraw(msg.sender, user.amount);
    }

    /**
     * @notice Stop rewards
     * @dev Only callable by owner. Needs to be for emergency.
     */
    function emergencyRewardWithdraw(uint256 _amount) external onlyOwner {
        rewardToken.safeTransfer(address(msg.sender), _amount);
    }

    /**
     * @notice Allows the owner to recover tokens sent to the contract by mistake
     * @param _token: token address
     * @dev Callable by owner
     */
    function recoverToken(address _token) external onlyOwner {
        require(_token != address(stakedToken), "Operations: Cannot recover staked token");
        require(_token != address(rewardToken), "Operations: Cannot recover reward token");

        uint256 balance = IERC20Metadata(_token).balanceOf(address(this));
        require(balance != 0, "Operations: Cannot recover zero balance");

        IERC20Metadata(_token).safeTransfer(address(msg.sender), balance);

        emit TokenRecovery(_token, balance);
    }

    /**
     * @notice Stop rewards
     * @dev Only callable by owner
     */
    function stopReward() external onlyOwner {
        bonusEndBlock = block.number;
    }

    /**
     * @notice Update pool limit per user
     * @dev Only callable by owner.
     * @param _userLimit: whether the limit remains forced
     * @param _poolLimitPerUser: new pool limit per user
     */
    function updatePoolLimitPerUser(bool _userLimit, uint256 _poolLimitPerUser) external onlyOwner {
        require(userLimit, "Must be set");
        if (_userLimit) {
            require(_poolLimitPerUser > poolLimitPerUser, "New limit must be higher");
            poolLimitPerUser = _poolLimitPerUser;
        } else {
            userLimit = _userLimit;
            poolLimitPerUser = 0;
        }
        emit NewPoolLimit(poolLimitPerUser);
    }

    /**
     * @notice Update pool capacity
     * @dev Only callable by owner.
     * @param _poolCapacity: new pool capacity
     */
    function updatePoolCapacity(uint256 _poolCapacity) external onlyOwner {
        require(poolCapacity != _poolCapacity, "New value must be different");
        poolCapacity = _poolCapacity;
    }

    /**
     * @notice Update participant threshold
     * @dev Only callable by owner.
     * @param _participantThreshold: new participant threshold value
     */
    function updateParticipantThreshold(uint256 _participantThreshold) external onlyOwner {
        require(block.number < startBlock, "Pool has started");
        participantThreshold = _participantThreshold;
    }

    /**
     * @notice Update reward per block
     * @dev Only callable by owner.
     * @param _rewardPerBlock: the reward per block
     */
    function updateRewardPerBlock(uint256 _rewardPerBlock) external onlyOwner {
        require(block.number < startBlock, "Pool has started");
        rewardPerBlock = _rewardPerBlock;
        emit NewRewardPerBlock(_rewardPerBlock);
    }

    /**
     * @notice It allows the admin to update start and end blocks
     * @dev This function is only callable by owner.
     * @param _startBlock: the new start block
     * @param _bonusEndBlock: the new end block
     */
    function updateStartAndEndBlocks(uint256 _startBlock, uint256 _bonusEndBlock) external onlyOwner {
        require(block.number < startBlock, "Pool has started");
        require(_startBlock < _bonusEndBlock, "New startBlock must be lower than new endBlock");
        require(block.number < _startBlock, "New startBlock must be higher than current block");

        startBlock = _startBlock;
        bonusEndBlock = _bonusEndBlock;

        // Set the lastRewardBlock as the startBlock
        lastRewardBlock = startBlock;

        emit NewStartAndEndBlocks(_startBlock, _bonusEndBlock);
    }

    /**
     * @notice View function to see pending reward on frontend.
     * @param _user: user address
     * @return Pending reward for a given user
     */
    function pendingReward(address _user) external view returns (uint256) {
        UserInfo storage user = userInfo[_user];
        uint256 stakedTokenSupply = stakedToken.balanceOf(address(this));
        if (stakedTokenSupply > 0 && stakedTokenSupply < participantThreshold) {
            stakedTokenSupply = participantThreshold;
        }

        if (block.number > lastRewardBlock && stakedTokenSupply != 0) {
            uint256 multiplier = _getMultiplier(lastRewardBlock, block.number);
            uint256 tokenReward = multiplier * rewardPerBlock;
            uint256 adjustedTokenPerShare = accTokenPerShare + (tokenReward * PRECISION_FACTOR) / stakedTokenSupply;
            return (user.amount * adjustedTokenPerShare) / PRECISION_FACTOR - user.rewardDebt;
        } else {
            return (user.amount * accTokenPerShare) / PRECISION_FACTOR - user.rewardDebt;
        }
    }

    /**
     * @notice Update reward variables of the given pool to be up-to-date.
     */
    function _updatePool() internal {
        if (block.number <= lastRewardBlock) {
            return;
        }

        uint256 stakedTokenSupply = stakedToken.balanceOf(address(this));
        if (stakedTokenSupply > 0 && stakedTokenSupply < participantThreshold) {
            stakedTokenSupply = participantThreshold;
        }

        if (stakedTokenSupply == 0) {
            lastRewardBlock = block.number;
            return;
        }

        uint256 multiplier = _getMultiplier(lastRewardBlock, block.number);
        uint256 tokenReward = multiplier * rewardPerBlock;
        accTokenPerShare = accTokenPerShare + (tokenReward * PRECISION_FACTOR) / stakedTokenSupply;
        lastRewardBlock = block.number;
    }

    /**
     * @notice Return reward multiplier over the given _from to _to block.
     * @param _from: block to start
     * @param _to: block to finish
     */
    function _getMultiplier(uint256 _from, uint256 _to) internal view returns (uint256) {
        if (_to <= bonusEndBlock) {
            return _to - _from;
        } else if (_from >= bonusEndBlock) {
            return 0;
        } else {
            return bonusEndBlock - _from;
        }
    }

    /**
     * @notice Return user limit is set or zero.
     */
    function hasUserLimit() public view returns (bool) {
        if (!userLimit || (block.number >= (startBlock + numberBlocksForUserLimit))) {
            return false;
        }

        return true;
    }

    function walletOfOwner(address _owner) external view returns(uint256[] memory) {
        uint256 tokenCount = stakedToken.balanceOf(_owner);
        if (tokenCount == 0) {
            return new uint256[](0);
        } else {
            uint256[] memory ownedTokenIds = new uint256[](tokenCount);
            uint256 index;
            uint256 loopThrough = IERC721Enumerable(address(stakedToken)).totalSupply();

            for (uint256 tokenId = 0; tokenId <= loopThrough; tokenId++) {
                if (index == tokenCount) break;

                try stakedToken.ownerOf(tokenId) returns (address result) {
                    if (result == _owner) {
                        ownedTokenIds[index] = tokenId;
                        index++;
                    }
                } catch {
                       loopThrough++;
                }
                
            }

            return ownedTokenIds;
        }
    }
}
