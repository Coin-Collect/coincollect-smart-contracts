// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ITreasuryLedger {
    function treasury() external view returns (address);
    function wrappedNative() external view returns (address);
    function supportedTokens(address token) external view returns (bool);
}

interface ITreasuryWrappedNative {
    function deposit() external payable;
}

/// @notice Custodies only available assets. Allocations move to the rewards ledger.
contract TreasuryVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Balance {
        uint256 available;
        uint256 deposited;
        uint256 allocated;
        uint256 spent;
        uint256 fundingReturned;
        uint256 rewardsReturned;
        uint256 withdrawn;
    }

    error Unauthorized();
    error InvalidAsset();
    error InsufficientAvailable();
    error InvalidTransfer();
    error TreasuryPaused();

    event Deposited(address indexed token, uint256 amount);
    event Allocated(uint256 indexed poolId, address indexed token, uint256 amount);
    event Spent(uint256 indexed poolId, address indexed token, uint256 amount);
    event Recovered(uint256 indexed poolId, address indexed token, uint256 amount, bool reward);
    event Withdrawn(address indexed token, uint256 amount);
    event PauseChanged(bool paused);

    ITreasuryLedger public immutable ledger;
    address public immutable owner;
    address public immutable wrappedNative;
    bool public paused;
    mapping(address => Balance) private balances;

    constructor(ITreasuryLedger rewardsLedger) {
        ledger = rewardsLedger;
        owner = rewardsLedger.treasury();
        wrappedNative = rewardsLedger.wrappedNative();
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyLedger() {
        if (msg.sender != address(ledger)) revert Unauthorized();
        _;
    }

    modifier whenRunning() {
        if (paused) revert TreasuryPaused();
        _;
    }

    function balance(address token) external view returns (Balance memory) {
        return balances[token];
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseChanged(value);
    }

    function deposit(address token, uint256 amount) external payable onlyOwner whenRunning nonReentrant {
        if (!ledger.supportedTokens(token) || amount == 0) revert InvalidAsset();
        IERC20 asset = IERC20(token);
        uint256 previous = asset.balanceOf(address(this));
        if (msg.value == 0) {
            asset.safeTransferFrom(msg.sender, address(this), amount);
        } else {
            if (token != wrappedNative || msg.value != amount) revert InvalidAsset();
            ITreasuryWrappedNative(token).deposit{value: amount}();
        }
        if (asset.balanceOf(address(this)) != previous + amount) revert InvalidTransfer();
        balances[token].available += amount;
        balances[token].deposited += amount;
        emit Deposited(token, amount);
    }

    function withdraw(address token, uint256 amount) external onlyOwner whenRunning nonReentrant {
        Balance storage funds = balances[token];
        if (amount == 0 || amount > funds.available) revert InsufficientAvailable();
        funds.available -= amount;
        funds.withdrawn += amount;
        _transferExact(token, owner, amount);
        emit Withdrawn(token, amount);
    }

    function allocate(uint256 poolId, address token, uint256 amount) external onlyLedger whenRunning nonReentrant {
        Balance storage funds = balances[token];
        if (amount == 0 || amount > funds.available) revert InsufficientAvailable();
        funds.available -= amount;
        funds.allocated += amount;
        _transferExact(token, address(ledger), amount);
        emit Allocated(poolId, token, amount);
    }

    function recordSpend(uint256 poolId, address token, uint256 amount) external onlyLedger whenRunning {
        balances[token].allocated -= amount;
        balances[token].spent += amount;
        emit Spent(poolId, token, amount);
    }

    // The ledger transfers and reconciles the exact balance delta before crediting the vault.
    function recordRecovery(uint256 poolId, address token, uint256 amount, bool reward) external onlyLedger {
        Balance storage funds = balances[token];
        if (reward) {
            funds.rewardsReturned += amount;
        } else {
            funds.allocated -= amount;
            funds.fundingReturned += amount;
        }
        funds.available += amount;
        emit Recovered(poolId, token, amount, reward);
    }

    function _transferExact(address token, address receiver, uint256 amount) private {
        IERC20 asset = IERC20(token);
        uint256 previous = asset.balanceOf(address(this));
        uint256 receiverPrevious = asset.balanceOf(receiver);
        asset.safeTransfer(receiver, amount);
        if (asset.balanceOf(address(this)) != previous - amount || asset.balanceOf(receiver) != receiverPrevious + amount) {
            revert InvalidTransfer();
        }
    }
}
