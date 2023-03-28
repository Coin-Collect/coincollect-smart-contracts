// SPDX-License-Identifier: MIT

pragma solidity ^0.7.4;

import '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import '@openzeppelin/contracts/token/ERC721/ERC721.sol';
import '@openzeppelin/contracts@3.4.2/token/ERC20/SafeERC20.sol';
import '@openzeppelin/contracts@3.4.2/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts@3.4.2/math/SafeMath.sol';
import '@openzeppelin/contracts/utils/EnumerableMap.sol';
import '@openzeppelin/contracts/utils/EnumerableSet.sol';
import './core/SafeOwnable.sol';
import './CoinCollectVault.sol';

contract CoinCollectNftStake is SafeOwnable, ReentrancyGuard {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;
    using EnumerableMap for EnumerableMap.UintToAddressMap;

    struct UserInfo {
        uint256 amount;     // How many LP tokens the user has provided.
        uint256 rewardDebt; // Reward debt. See explanation below.
    }

    struct PoolInfo {
        IERC20 lpToken;           // Address of LP token contract.
        ERC721 nftToken;          // Address of staking nft contract.
        uint256 allocPoint;       // How many allocation points assigned to this pool. CAKEs to distribute per block.
        uint256 lastRewardBlock;  // Last block number that CAKEs distribution occurs.
        uint256 accRewardPerShare; // Accumulated CAKEs per share, times 1e12. See below.
        uint256 poolCapacity; // User capacity to stake simultaneously
    }

    enum FETCH_VAULT_TYPE {
        FROM_ALL,
        FROM_BALANCE,
        FROM_TOKEN
    }

    IERC20 public immutable rewardToken;
    uint256 public startBlock;

    CoinCollectVault public vault;
    uint256 public rewardPerBlock;

    PoolInfo[] public poolInfo;
    mapping(IERC20 => bool) public pairExist;
    mapping(uint => bool) public pidInBlacklist;
    mapping (uint256 => mapping (address => UserInfo)) public userInfo;
    uint256 public totalAllocPoint = 0;
    FETCH_VAULT_TYPE public fetchVaultType;

    // Variables for NFT Stake
    mapping(address => EnumerableSet.UintSet) holderTokens;
    EnumerableMap.UintToAddressMap tokenOwners;
    mapping(uint256 => uint256) public tokenWeight;
    address public pegVault; // Vault for NFT pegging ERC-20 tokens

    event Deposit(address indexed user, uint256 indexed pid, uint256 tokenId);
    event Harvest(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 tokenId);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount);

    modifier legalPid(uint _pid) {
        require(_pid > 0 && _pid < poolInfo.length, "illegal farm pid"); 
        _;
    }

    modifier availablePid(uint _pid) {
        require(!pidInBlacklist[_pid], "illegal pid ");
        _;
    }

    function fetch(address _to, uint _amount) internal returns(uint) {
        if (fetchVaultType == FETCH_VAULT_TYPE.FROM_ALL) {
            return vault.mint(_to, _amount);
        } else if (fetchVaultType == FETCH_VAULT_TYPE.FROM_BALANCE) {
            return vault.mintOnlyFromBalance(_to, _amount);
        } else if (fetchVaultType == FETCH_VAULT_TYPE.FROM_TOKEN) {
            return vault.mintOnlyFromToken(_to, _amount);
        } 
        return 0;
    }
    
    constructor(CoinCollectVault _vault, uint256 _rewardPerBlock, uint256 _startBlock, address _owner, address _pegVault, uint[] memory _allocPoints, IERC20[] memory _lpTokens, ERC721[] memory _nftTokens) {
        require(address(_vault) != address(0), "_vault address cannot be 0");
        require(_pegVault != address(0), "_pegVault address cannot be 0");
        require(_startBlock >= block.number, "illegal startBlock");
        rewardToken = _vault.coinCollectToken();
        startBlock = _startBlock;
        vault = _vault;
        rewardPerBlock = _rewardPerBlock;
        pegVault = _pegVault;
        //we skip the zero index pool, and start at index 1
        poolInfo.push(PoolInfo({
            lpToken: IERC20(address(0)),
            allocPoint: 0,
            lastRewardBlock: block.number,
            accRewardPerShare: 0,
            poolCapacity: 0
        }));
        require(_allocPoints.length > 0 && _allocPoints.length == _lpTokens.length, "illegal data");
        for (uint i = 0; i < _allocPoints.length; i ++) {
            require(!pairExist[_lpTokens[i]], "already exist");
            totalAllocPoint = totalAllocPoint.add(_allocPoints[i]);
            poolInfo.push(PoolInfo({
                lpToken: _lpTokens[i],
                nftToken: _nftTokens[i],
                allocPoint: _allocPoints[i],
                lastRewardBlock: _startBlock,
                accRewardPerShare: 0,
                poolCapacity: 1000
            }));
            pairExist[_lpTokens[i]] = true;
        }
        if (_owner != address(0)) {
            _transferOwnership(_owner);
        }
        fetchVaultType = FETCH_VAULT_TYPE.FROM_ALL;
    }

    function setVault(CoinCollectVault _vault) external onlyOwner {
        require(_vault.coinCollectToken() == rewardToken, "illegal vault");
        vault = _vault;
    }

    function disablePid(uint _pid) external onlyOwner legalPid(_pid) {
        pidInBlacklist[_pid] = true;
    }

    function enablePid(uint _pid) external onlyOwner legalPid(_pid) {
        delete pidInBlacklist[_pid];
    }

    function setRewardPerBlock(uint _rewardPerBlock) external onlyOwner {
        massUpdatePools();
        rewardPerBlock = _rewardPerBlock;
    }

    function setFetchVaultType(FETCH_VAULT_TYPE _newType) external onlyOwner {
        fetchVaultType = _newType;
    }

    function setStartBlock(uint _newStartBlock) external onlyOwner {
        require(block.number < startBlock && _newStartBlock >= block.number, "illegal start Block Number");
        startBlock = _newStartBlock;
        for (uint i = 0; i < poolInfo.length; i ++) {
            poolInfo[i].lastRewardBlock = _newStartBlock;
        }
    }

    function poolLength() external view returns (uint256) {
        return poolInfo.length;
    }

    function updatePool(uint256 _pid) public legalPid(_pid) {
        PoolInfo storage pool = poolInfo[_pid];
        if (block.number <= pool.lastRewardBlock) {
            return;
        }
        uint256 lpSupply = pool.lpToken.balanceOf(address(this));
        if (lpSupply == 0 || totalAllocPoint == 0) {
            pool.lastRewardBlock = block.number;
            return;
        }
        uint256 multiplier = block.number.sub(pool.lastRewardBlock);
        uint256 reward = multiplier.mul(rewardPerBlock).mul(pool.allocPoint).div(totalAllocPoint);
        pool.accRewardPerShare = pool.accRewardPerShare.add(reward.mul(1e12).div(lpSupply));
        pool.lastRewardBlock = block.number;
    }

    function massUpdatePools() public {
        uint256 length = poolInfo.length;
        for (uint256 pid = 1; pid < length; ++pid) {
            if (!pidInBlacklist[pid]) {
                updatePool(pid);
            }
        }
    }

    function add(uint256 _allocPoint, uint256 _poolCapacity, IERC20 _lpToken, ERC721 _nftToken, bool _withUpdate) public onlyOwner {
        require(!pairExist[_lpToken], "already exist");
        if (_withUpdate) {
            massUpdatePools();
        }
        uint256 lastRewardBlock = block.number > startBlock ? block.number : startBlock;
        totalAllocPoint = totalAllocPoint.add(_allocPoint);
        poolInfo.push(PoolInfo({
            lpToken: _lpToken,
            nftToken: _nftToken,
            allocPoint: _allocPoint,
            lastRewardBlock: lastRewardBlock,
            accRewardPerShare: 0,
            poolCapacity: _poolCapacity
        }));
        pairExist[_lpToken] = true;
    }

    function set(uint256 _pid, uint256 _allocPoint, bool _withUpdate) public onlyOwner legalPid(_pid) {
        if (_withUpdate) {
            massUpdatePools();
        }
        uint256 prevAllocPoint = poolInfo[_pid].allocPoint;
        poolInfo[_pid].allocPoint = _allocPoint;
        if (prevAllocPoint != _allocPoint) {
            totalAllocPoint = totalAllocPoint.sub(prevAllocPoint).add(_allocPoint);
        }
    }

    function setPoolCapacity(uint256 _pid, uint256 _poolCapacity) public onlyOwner legalPid(_pid) {
        poolInfo[_pid].poolCapacity = _poolCapacity;
    }

    function getPoolCapacity(uint256 _pid) external view legalPid(_pid) returns (uint256) {
        return poolInfo[_pid].poolCapacity;
    }

    function pendingReward(uint256 _pid, address _user) external view legalPid(_pid) returns (uint256) {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][_user];
        uint256 accRewardPerShare = pool.accRewardPerShare;
        uint256 lpSupply = pool.lpToken.balanceOf(address(this));
        if (block.number > pool.lastRewardBlock && lpSupply != 0) {
            uint256 multiplier = block.number.sub(pool.lastRewardBlock);
            uint256 reward = multiplier.mul(rewardPerBlock).mul(pool.allocPoint).div(totalAllocPoint);
            accRewardPerShare = accRewardPerShare.add(reward.mul(1e12).div(lpSupply));
        }
        return user.amount.mul(accRewardPerShare).div(1e12).sub(user.rewardDebt);
    }

    function deposit(uint256 _pid, uint256 _tokenId) external legalPid(_pid) availablePid(_pid) nonReentrant {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        updatePool(_pid);

        uint _amount = 1e18; // 1 NFT = 1 ERC-20 Token

        if (user.amount > 0) {
            uint256 pending = user.amount.mul(pool.accRewardPerShare).div(1e12).sub(user.rewardDebt);
            if(pending > 0) {
                require(fetch(msg.sender, pending) == pending, "out of token");
            }
        }

            // User deposit first time, new staker
            if (user.amount == 0) {
                require(pool.poolCapacity > 0, "pool is out of capacity");
                pool.poolCapacity = pool.poolCapacity.sub(1);
            }
            pool.lpToken.safeTransferFrom(pegVault, address(this), _amount);
            nftToken.transferFrom(msg.sender, address(this), _tokenId);
            user.amount = user.amount.add(_amount);
            holderTokens[msg.sender].add(_tokenId);
            tokenOwners.set(_tokenId, msg.sender);
            tokenWeight[_tokenId] = _amount;
        user.rewardDebt = user.amount.mul(pool.accRewardPerShare).div(1e12);
        emit Deposit(msg.sender, _pid, _tokenId);
    }

    function harvest(uint256 _pid) external legalPid(_pid) availablePid(_pid) nonReentrant {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        updatePool(_pid);

        uint256 pending = 0;
        if (user.amount > 0) {
            pending = user.amount.mul(pool.accRewardPerShare).div(1e12).sub(user.rewardDebt);
            if(pending > 0) {
                require(fetch(msg.sender, pending) == pending, "out of token");
            }
        }

        user.rewardDebt = user.amount.mul(pool.accRewardPerShare).div(1e12);
        emit Harvest(msg.sender, _pid, pending);
    }

    function withdraw(uint256 _pid, uint256 _tokenId) external legalPid(_pid) nonReentrant {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        updatePool(_pid);
        uint256 pending = user.amount.mul(pool.accRewardPerShare).div(1e12).sub(user.rewardDebt);
        if(pending > 0) {
            require(fetch(msg.sender, pending) == pending, "out of token");
        }

        uint _amount = tokenWeight[_tokenId];

        if(_amount > 0) {
            user.amount = user.amount.sub(_amount);
            pool.lpToken.safeTransfer(pegVault, _amount);
            tokenOwners.remove(_tokenId);
            holderTokens[msg.sender].remove(_tokenId);
            nftToken.transferFrom(address(this), msg.sender, _tokenId);
            delete tokenWeight[_tokenId];
            // User leaves the pool, add capacity
            if(user.amount == 0) {
                pool.poolCapacity = pool.poolCapacity.add(1);
            }
        }
        user.rewardDebt = user.amount.mul(pool.accRewardPerShare).div(1e12);
        emit Withdraw(msg.sender, _pid, _tokenId);
    }

}