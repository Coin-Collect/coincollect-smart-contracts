// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Admin-reviewed assets. Known proxies must expose a live implementation identity.
contract TreasuryAssetsV36 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant DEPOSIT = 1;
    uint8 public constant REWARD = 2;
    uint8 public constant SWAP = 4;
    uint256 public constant MAX_ASSETS = 64;
    bytes4 private constant IMPLEMENTATION = bytes4(keccak256("implementation()"));

    struct Review {
        bytes32 runtimeHash;
        address implementation;
        bytes32 implementationHash;
        bytes32 evidenceHash;
        uint8 decimals;
    }

    struct Asset {
        Review review;
        uint8 permissions;
    }

    error Unauthorized();
    error InvalidAssetReview();
    error InexactAssetTransfer();

    event AssetReviewed(address indexed token, bytes32 indexed evidenceHash, bytes32 runtimeHash, address implementation);
    event AssetPermissionsChanged(address indexed token, uint8 permissions);

    address public immutable admin;
    mapping(address => Asset) private assets;
    address[] private listed;

    constructor(address governor) {
        if ((block.chainid != 137 && block.chainid != 31337) || governor == address(0)) revert InvalidAssetReview();
        admin = governor;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    function registeredAssets() external view returns (address[] memory) {
        return listed;
    }

    function assetState(address token) external view returns (Asset memory entry, bool identityValid) {
        entry = assets[token];
        identityValid = _validIdentity(token, entry.review);
    }

    function permitted(address token, uint8 permissions) external view returns (bool) {
        Asset storage entry = assets[token];
        return (entry.permissions & permissions) == permissions && permissions != 0 && _validIdentity(token, entry.review);
    }

    /// @notice A review binds a supported runtime, decimal scale, risk evidence and nonzero exact round-trip.
    /// @dev Re-review requires a prior quarantine. Existing pools retain the original scale and token address.
    function reviewAsset(address token, Review calldata review, uint256 probe, uint8 permissions)
        external onlyAdmin nonReentrant
    {
        Asset storage entry = assets[token];
        if (review.evidenceHash == 0 || review.decimals > 36 || permissions > 7 || probe == 0
            || !_validIdentity(token, review)) revert InvalidAssetReview();

        if (entry.review.evidenceHash == 0) {
            if (listed.length == MAX_ASSETS) revert InvalidAssetReview();
            listed.push(token);
        } else if (entry.permissions != 0 || entry.review.decimals != review.decimals) {
            revert InvalidAssetReview();
        }

        IERC20 asset = IERC20(token);
        uint256 beforeRegistry = asset.balanceOf(address(this));
        uint256 beforeAdmin = asset.balanceOf(admin);
        asset.safeTransferFrom(admin, address(this), probe);
        if (asset.balanceOf(address(this)) != beforeRegistry + probe || asset.balanceOf(admin) != beforeAdmin - probe) {
            revert InexactAssetTransfer();
        }
        asset.safeTransfer(admin, probe);
        if (asset.balanceOf(address(this)) != beforeRegistry || asset.balanceOf(admin) != beforeAdmin) {
            revert InexactAssetTransfer();
        }

        entry.review = review;
        entry.permissions = permissions;
        emit AssetReviewed(token, review.evidenceHash, review.runtimeHash, review.implementation);
        emit AssetPermissionsChanged(token, permissions);
    }

    function setPermissions(address token, uint8 permissions) external onlyAdmin nonReentrant {
        Asset storage entry = assets[token];
        if (entry.review.evidenceHash == 0 || permissions > 7
            || (permissions & ~entry.permissions != 0 && !_validIdentity(token, entry.review))) revert InvalidAssetReview();
        entry.permissions = permissions;
        emit AssetPermissionsChanged(token, permissions);
    }

    function _validIdentity(address token, Review memory review) private view returns (bool) {
        if (review.runtimeHash == 0 || token.code.length == 0 || token.codehash != review.runtimeHash
            || _readWord(token, IERC20Metadata.decimals.selector) != review.decimals) return false;
        uint256 exposed = _readWord(token, IMPLEMENTATION);
        if (review.implementation == address(0)) {
            return review.implementationHash == 0 && (exposed == type(uint256).max || exposed == 0);
        }
        return exposed == uint160(review.implementation) && review.implementation.code.length != 0
            && review.implementation.codehash == review.implementationHash;
    }

    /// @dev Bounds callee gas and copied return data, including when inspecting untrusted candidates.
    function _readWord(address token, bytes4 selector) private view returns (uint256 value) {
        bytes memory input = abi.encodeWithSelector(selector);
        assembly ("memory-safe") {
            let ok := staticcall(30000, token, add(input, 32), 4, 0, 32)
            value := not(0)
            if and(ok, eq(returndatasize(), 32)) { value := mload(0) }
        }
    }
}
