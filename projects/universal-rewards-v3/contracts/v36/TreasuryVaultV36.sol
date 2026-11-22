// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ITreasuryLedger, ITreasuryWrappedNative} from "../TreasuryVault.sol";
import {TreasuryAssetsV36} from "./TreasuryAssetsV36.sol";
import {RewardRoutePlannerV36} from "./RewardRoutePlannerV36.sol";

interface IV36TreasuryLedger is ITreasuryLedger {
    function registry() external view returns (TreasuryAssetsV36);
    function swapAdapter() external view returns (address);
}

interface IUnwrapNative {
    function withdraw(uint256 amount) external;
}

/// @notice Available balances live here. Allocated funds live in the rewards ledger.
contract TreasuryVaultV36 is ReentrancyGuard {
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

    struct SwapTotals {
        uint256 swappedIn;
        uint256 swappedOut;
    }

    error Unauthorized();
    error InvalidAsset();
    error InsufficientAvailable();
    error InvalidTransfer();
    error TreasuryPaused();
    error InvalidSwap();
    error InvalidDeadline();

    event Deposited(address indexed token, uint256 amount);
    event Allocated(uint256 indexed poolId, address indexed token, uint256 amount);
    event Spent(uint256 indexed poolId, address indexed token, uint256 amount);
    event Recovered(uint256 indexed poolId, address indexed token, uint256 amount, bool reward);
    event Withdrawn(address indexed token, uint256 amount);
    event NativeWithdrawn(address indexed token, uint256 amount);
    event PauseChanged(bool paused);
    event TreasurySwap(address indexed input, address indexed output, uint8 route, uint256 amountIn, uint256 amountOut);

    IV36TreasuryLedger public immutable ledger;
    TreasuryAssetsV36 public immutable registry;
    RewardRoutePlannerV36 public immutable planner;
    address public immutable owner;
    address public immutable wrappedNative;
    bool public paused;
    mapping(address => Balance) private balances;
    mapping(address => SwapTotals) public swapTotals;

    constructor(IV36TreasuryLedger rewardsLedger) {
        ledger = rewardsLedger;
        owner = rewardsLedger.treasury();
        wrappedNative = rewardsLedger.wrappedNative();
        registry = rewardsLedger.registry();
        planner = RewardRoutePlannerV36(rewardsLedger.swapAdapter());
        if (registry.admin() != owner || planner.admin() != owner || planner.registry() != registry
            || planner.wrappedNative() != wrappedNative) revert InvalidAsset();
    }

    receive() external payable {
        if (msg.sender != wrappedNative) revert Unauthorized();
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
        if (!registry.permitted(token, 1) || amount == 0) revert InvalidAsset();
        IERC20 asset = IERC20(token);
        uint256 previous = asset.balanceOf(address(this));
        if (msg.value == 0) {
            uint256 beforeOwner = asset.balanceOf(owner);
            asset.safeTransferFrom(owner, address(this), amount);
            if (asset.balanceOf(owner) != beforeOwner - amount) revert InvalidTransfer();
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
        _withdraw(token, amount);
        _transferExact(token, owner, amount);
    }

    function withdrawNative(uint256 amount) external onlyOwner whenRunning nonReentrant {
        address token = wrappedNative;
        // Unwrap crosses a second trust boundary. ERC-20 withdrawal remains possible if a reviewed identity drifts.
        (, bool valid) = registry.assetState(token);
        if (!valid) revert InvalidAsset();
        _withdraw(token, amount);
        IERC20 wrapped = IERC20(token);
        uint256 previous = wrapped.balanceOf(address(this));
        uint256 beforeNative = address(this).balance;
        IUnwrapNative(token).withdraw(amount);
        if (wrapped.balanceOf(address(this)) != previous - amount || address(this).balance != beforeNative + amount) {
            revert InvalidTransfer();
        }
        (bool sent,) = owner.call{value: amount}("");
        if (!sent || address(this).balance != beforeNative) revert InvalidTransfer();
        emit NativeWithdrawn(token, amount);
    }

    function _withdraw(address token, uint256 amount) private {
        _debit(token, amount);
        balances[token].withdrawn += amount;
        emit Withdrawn(token, amount);
    }

    function allocate(uint256 poolId, address token, uint256 amount) external onlyLedger whenRunning nonReentrant {
        // Continue honoring existing pool plans after permission changes.
        _debit(token, amount);
        balances[token].allocated += amount;
        _transferExact(token, address(ledger), amount);
        emit Allocated(poolId, token, amount);
    }

    function recordSpend(uint256 poolId, address token, uint256 amount) external onlyLedger whenRunning nonReentrant {
        balances[token].allocated -= amount;
        balances[token].spent += amount;
        emit Spent(poolId, token, amount);
    }

    function recordRecovery(uint256 poolId, address token, uint256 amount, bool reward) external onlyLedger nonReentrant {
        Balance storage funds = balances[token];
        if (reward) funds.rewardsReturned += amount;
        else {
            funds.allocated -= amount;
            funds.fundingReturned += amount;
        }
        funds.available += amount;
        if (IERC20(token).balanceOf(address(this)) < funds.available) revert InvalidTransfer();
        emit Recovered(poolId, token, amount, reward);
    }

    function quoteTreasurySwap(address input, address output, uint256 amount)
        external view whenRunning returns (uint8 route, uint256 quoted, uint256 minimum)
    {
        _checkSwap(input, output, amount);
        return planner.bestRoute(input, output, amount, 0);
    }

    function swapTreasury(address input, address output, uint8 route, uint256 amount, uint256 minimum, uint256 deadline)
        external onlyOwner whenRunning nonReentrant returns (uint256 received)
    {
        if (minimum == 0) revert InvalidSwap();
        if (deadline < block.timestamp || deadline - block.timestamp > 5 minutes) revert InvalidDeadline();
        _checkSwap(input, output, amount);
        _debit(input, amount);

        IERC20 source = IERC20(input);
        IERC20 target = IERC20(output);
        uint256 sourceBefore = source.balanceOf(address(this));
        uint256 targetBefore = target.balanceOf(address(this));
        source.forceApprove(address(planner), amount);
        received = planner.swapExactPath(input, output, route, amount, minimum, deadline);
        source.forceApprove(address(planner), 0);
        if (received < minimum || source.balanceOf(address(this)) != sourceBefore - amount
            || target.balanceOf(address(this)) != targetBefore + received) revert InvalidTransfer();

        balances[output].available += received;
        swapTotals[input].swappedOut += amount;
        swapTotals[output].swappedIn += received;
        emit TreasurySwap(input, output, route, amount, received);
    }

    function _checkSwap(address input, address output, uint256 amount) private view {
        if (input == output || !registry.permitted(input, 4) || !registry.permitted(output, 4)) revert InvalidSwap();
        if (amount == 0 || amount > balances[input].available) revert InsufficientAvailable();
        if (IERC20(input).balanceOf(address(this)) < balances[input].available
            || IERC20(output).balanceOf(address(this)) < balances[output].available) revert InvalidTransfer();
    }

    function _debit(address token, uint256 amount) private {
        Balance storage funds = balances[token];
        if (amount == 0 || amount > funds.available) revert InsufficientAvailable();
        if (IERC20(token).balanceOf(address(this)) < funds.available) revert InvalidTransfer();
        funds.available -= amount;
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
