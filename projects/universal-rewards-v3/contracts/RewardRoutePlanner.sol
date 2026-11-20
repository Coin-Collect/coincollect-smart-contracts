// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RewardSwapAdapter} from "./RewardSwapAdapter.sol";

/// @notice Selects among a bounded set of reviewed direct and two-hop Polygon routes.
contract RewardRoutePlanner is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant MAX_ROUTES = 4;
    uint256 private constant MAX_DEADLINE = 5 minutes;

    struct Path {
        RewardSwapAdapter first;
        address intermediate;
        RewardSwapAdapter second;
        bool enabled;
    }

    error Unauthorized();
    error InvalidRoute();
    error NoApprovedRoute();
    error InvalidDeadline();
    error UnexpectedTransfer();
    error Paused();

    event AdapterApproval(address indexed adapter, bytes32 codeHash);
    event AssetPermission(address indexed asset, bool allowed);
    event PathConfigured(address indexed input, address indexed output, uint8 indexed index);
    event Swapped(address indexed payer, address indexed input, address indexed output, uint8 route, uint256 spent, uint256 received);
    event PauseChanged(bool paused);

    address public immutable admin;
    address public immutable wrappedNative;
    bool public paused;
    mapping(address => bytes32) public approvedAdapterHash;
    mapping(address => bool) public approvedAsset;
    mapping(address => mapping(address => Path[])) private paths;

    constructor(address routeAdmin, address wrapped) {
        if (routeAdmin == address(0) || wrapped.code.length == 0) revert InvalidRoute();
        admin = routeAdmin;
        wrappedNative = wrapped;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    function setPaused(bool value) external onlyAdmin {
        paused = value;
        emit PauseChanged(value);
    }

    function setAsset(address asset, bool allow) external onlyAdmin {
        if (asset.code.length == 0) revert InvalidRoute();
        approvedAsset[asset] = allow;
        emit AssetPermission(asset, allow);
    }

    function setAdapter(RewardSwapAdapter adapter, bytes32 expectedHash) external onlyAdmin {
        if (
            expectedHash != 0 && (address(adapter).code.length == 0 || address(adapter).codehash != expectedHash
                || adapter.wrappedNative() != wrappedNative)
        ) revert InvalidRoute();
        approvedAdapterHash[address(adapter)] = expectedHash;
        emit AdapterApproval(address(adapter), expectedHash);
    }

    function configurePath(address input, address output, uint8 index, Path calldata path) external onlyAdmin {
        Path[] storage routes = paths[input][output];
        if (index >= MAX_ROUTES || index > routes.length || input == output) revert InvalidRoute();
        if (path.enabled) _validatePath(input, output, path);
        if (index == routes.length) routes.push(path);
        else routes[index] = path;
        emit PathConfigured(input, output, index);
    }

    function routeOptions(address input, address output) external view returns (Path[] memory) {
        return paths[input][output];
    }

    function preview(address input, address output, uint256 amount, uint256 callerMinimum)
        external view returns (uint256 quoted, uint256 minimum)
    {
        (, quoted, minimum) = bestRoute(input, output, amount, callerMinimum);
    }

    function bestRoute(address input, address output, uint256 amount, uint256 callerMinimum)
        public view returns (uint8 index, uint256 quoted, uint256 minimum)
    {
        if (paused) revert Paused();
        (index, quoted, minimum) = _bestRoute(input, output, amount, callerMinimum, 0);
        if (quoted == 0) revert NoApprovedRoute();
    }

    function _bestRoute(address input, address output, uint256 amount, uint256 callerMinimum, uint8 excluded)
        private view returns (uint8 index, uint256 quoted, uint256 minimum)
    {
        uint256 length = paths[input][output].length;
        for (uint8 i; i < length; ++i) {
            if ((excluded & uint8(1 << i)) != 0) continue;
            try this.quotePath(input, output, i, amount, callerMinimum) returns (uint256 candidate, uint256 floor) {
                if (candidate > quoted) (index, quoted, minimum) = (i, candidate, floor);
            } catch {}
        }
    }

    function quotePath(address input, address output, uint8 index, uint256 amount, uint256 callerMinimum)
        external view returns (uint256 quoted, uint256 minimum)
    {
        if (paused) revert Paused();
        Path storage path = paths[input][output][index];
        _validatePath(input, output, path);
        if (path.intermediate == address(0)) return path.first.preview(input, output, amount, callerMinimum);
        (uint256 intermediate, uint256 firstFloor) = path.first.preview(input, path.intermediate, amount, 0);
        (quoted,) = path.second.preview(path.intermediate, output, intermediate, 0);
        (, uint256 secondFloor) = path.second.preview(path.intermediate, output, firstFloor, 0);
        minimum = Math.max(callerMinimum, secondFloor);
        if (minimum > quoted) revert InvalidRoute();
    }

    function swapExact(address input, address output, uint256 amount, uint256 callerMinimum, uint256 deadline)
        external nonReentrant returns (uint256 received)
    {
        if (paused) revert Paused();
        if (deadline < block.timestamp || deadline - block.timestamp > MAX_DEADLINE) revert InvalidDeadline();
        IERC20 asset = IERC20(input);
        uint256 starting = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        if (asset.balanceOf(address(this)) != starting + amount) revert UnexpectedTransfer();

        uint8 excluded;
        for (uint8 attempt; attempt < paths[input][output].length; ++attempt) {
            (uint8 index, uint256 quoted, uint256 minimum) = _bestRoute(input, output, amount, callerMinimum, excluded);
            if (quoted == 0) break;
            try this.executePath(input, output, index, amount, minimum, deadline, msg.sender) returns (uint256 outputAmount) {
                if (asset.balanceOf(address(this)) != starting) revert UnexpectedTransfer();
                emit Swapped(msg.sender, input, output, index, amount, outputAmount);
                return outputAmount;
            } catch {
                excluded |= uint8(1 << index);
            }
        }
        revert NoApprovedRoute();
    }

    /// @dev External self-call makes a reverted candidate atomic before trying the next candidate.
    function executePath(
        address input, address output, uint8 index, uint256 amount, uint256 minimum, uint256 deadline, address receiver
    ) external returns (uint256 received) {
        if (msg.sender != address(this)) revert Unauthorized();
        Path storage path = paths[input][output][index];
        IERC20 reward = IERC20(output);
        uint256 beforeReward = reward.balanceOf(address(this));
        if (path.intermediate == address(0)) {
            received = _swap(path.first, input, output, amount, minimum, deadline);
        } else {
            IERC20 middle = IERC20(path.intermediate);
            uint256 beforeMiddle = middle.balanceOf(address(this));
            uint256 intermediate = _swap(path.first, input, path.intermediate, amount, 0, deadline);
            if (middle.balanceOf(address(this)) != beforeMiddle + intermediate) revert UnexpectedTransfer();
            received = _swap(path.second, path.intermediate, output, intermediate, minimum, deadline);
            if (middle.balanceOf(address(this)) != beforeMiddle) revert UnexpectedTransfer();
        }
        uint256 beforeReceiver = reward.balanceOf(receiver);
        reward.safeTransfer(receiver, received);
        if (reward.balanceOf(address(this)) != beforeReward || reward.balanceOf(receiver) != beforeReceiver + received) {
            revert UnexpectedTransfer();
        }
    }

    function _swap(
        RewardSwapAdapter adapter, address input, address output, uint256 amount, uint256 minimum, uint256 deadline
    ) private returns (uint256 received) {
        IERC20 asset = IERC20(input);
        uint256 beforeInput = asset.balanceOf(address(this));
        uint256 beforeOutput = IERC20(output).balanceOf(address(this));
        asset.forceApprove(address(adapter), amount);
        received = adapter.swapExact(input, output, amount, minimum, deadline);
        asset.forceApprove(address(adapter), 0);
        if (asset.balanceOf(address(this)) != beforeInput - amount || IERC20(output).balanceOf(address(this)) != beforeOutput + received) {
            revert UnexpectedTransfer();
        }
    }

    function _validatePath(address input, address output, Path memory path) private view {
        if (!path.enabled || !approvedAsset[input] || !approvedAsset[output] || !_approved(path.first)) revert InvalidRoute();
        if (path.intermediate == address(0)) {
            if (address(path.second) != address(0)) revert InvalidRoute();
        } else if (
            path.intermediate == input || path.intermediate == output || !approvedAsset[path.intermediate]
                || !_approved(path.second)
        ) revert InvalidRoute();
    }

    function _approved(RewardSwapAdapter adapter) private view returns (bool) {
        bytes32 expected = approvedAdapterHash[address(adapter)];
        return expected != 0 && address(adapter).codehash == expected;
    }
}
