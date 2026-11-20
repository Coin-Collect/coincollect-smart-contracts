// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/// @notice Collection-authenticated transfer stream and holder intents for a single settlement ledger.
/// The reviewed NFT collection must call onTransfer for every transfer, mint and burn.
contract NftSourceJournal {
    error InvalidAction();

    event Observation(
        uint64 indexed sequence, uint8 action, uint256 indexed poolId, uint256 indexed tokenId,
        address from, address to, uint128 amount, uint128 balance, uint64 occurredAt
    );

    address public immutable collection;
    address public immutable settlementLedger;
    uint16 public immutable standard;
    uint64 public sequence;

    constructor(address nft, address settlement, uint16 tokenStandard) {
        if (nft.code.length == 0 || settlement == address(0) || (tokenStandard != 721 && tokenStandard != 1155)) {
            revert InvalidAction();
        }
        collection = nft;
        settlementLedger = settlement;
        standard = tokenStandard;
    }

    function onTransfer(address from, address to, uint256 tokenId, uint256 amount) external {
        if (msg.sender != collection) revert InvalidAction();
        // A position can hold at most uint128 units. Larger transfers move its entire entitlement.
        uint128 moved = amount > type(uint128).max ? type(uint128).max : uint128(amount);
        emit Observation(++sequence, 0, 0, tokenId, from, to, moved, 0, uint64(block.timestamp));
    }

    function request(uint8 action, uint256 poolId, uint256 tokenId, uint32 amount) external {
        if (action == 0 || action > 3 || poolId == 0 || (action == 3 ? amount != 0 : amount == 0)) revert InvalidAction();
        uint256 owned = standard == 1155 ? IERC1155(collection).balanceOf(msg.sender, tokenId)
            : IERC721(collection).ownerOf(tokenId) == msg.sender ? 1 : 0;
        if (owned == 0 || amount > owned) revert InvalidAction();
        uint128 boundedBalance = owned > type(uint128).max ? type(uint128).max : uint128(owned);
        emit Observation(++sequence, action, poolId, tokenId, msg.sender, address(0), amount, boundedBalance, uint64(block.timestamp));
    }
}
