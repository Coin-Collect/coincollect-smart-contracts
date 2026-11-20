// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

interface IHook {
    function onTransfer(address from, address to, uint256 id, uint256 amount) external;
}

contract Hooked1155Fixture is ERC1155 {
    address public immutable governor = msg.sender;
    address public rewardsHook;

    constructor() ERC1155("ipfs://sample/{id}.json") {}

    function setHook(address hook) external {
        require(msg.sender == governor && rewardsHook == address(0) && hook.code.length != 0);
        rewardsHook = hook;
    }

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    function burn(uint256 id, uint256 amount) external {
        _burn(msg.sender, id, amount);
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        super._update(from, to, ids, values);
        if (rewardsHook != address(0)) {
            for (uint256 i; i < ids.length; ++i) IHook(rewardsHook).onTransfer(from, to, ids[i], values[i]);
        }
    }
}

contract Hooked721Fixture is ERC721 {
    address public immutable governor = msg.sender;
    address public rewardsHook;

    constructor() ERC721("Journal NFT", "JNFT") {}

    function setHook(address hook) external {
        require(msg.sender == governor && rewardsHook == address(0) && hook.code.length != 0);
        rewardsHook = hook;
    }

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function _update(address to, uint256 id, address auth) internal override returns (address from) {
        from = super._update(to, id, auth);
        if (rewardsHook != address(0)) IHook(rewardsHook).onTransfer(from, to, id, 1);
    }
}
