// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract FixtureNft is ERC721 {
    constructor() ERC721("V3 fixture collection", "V3NFT") {}

    function mint(address owner, uint256 id) external {
        _mint(owner, id);
    }

    function burn(uint256 id) external {
        require(ownerOf(id) == msg.sender);
        _burn(id);
    }
}

contract FixtureToken is ERC20 {
    uint8 private immutable tokenDecimals;
    bool public transfersBlocked;

    constructor(uint8 decimals_) ERC20("V3 fixture reward", "V3R") {
        tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return tokenDecimals;
    }

    function mint(address owner, uint256 amount) external {
        _mint(owner, amount);
    }

    function setTransfersBlocked(bool blocked) external {
        transfersBlocked = blocked;
    }

    function _update(address from, address to, uint256 amount) internal override {
        require(from == address(0) || !transfersBlocked, "fixture: transfers blocked");
        super._update(from, to, amount);
    }
}
