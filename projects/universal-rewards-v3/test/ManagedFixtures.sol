// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {UniversalRewards} from "../contracts/UniversalRewards.sol";
import {ManagedRewardPositions} from "../contracts/ManagedRewardPositions.sol";

interface IHook {
    function onTransfer(address from, address to, uint256 id, uint256 amount) external;
}

contract Plain1155Fixture is ERC1155 {
    constructor() ERC1155("ipfs://plain/{id}.json") {}
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


contract Forwarding1155Receiver is ERC1155Holder {
    address private immutable finalOwner;
    address private immutable hook;
    bool public forgedHookRejected;

    constructor(address receiver, address adapter) {
        finalOwner = receiver;
        hook = adapter;
    }

    function onERC1155Received(address, address from, uint256 id, uint256 value, bytes memory)
        public override returns (bytes4)
    {
        (bool accepted,) = hook.call(abi.encodeCall(IHook.onTransfer, (from, finalOwner, id, value)));
        forgedHookRejected = !accepted;
        ERC1155(msg.sender).safeTransferFrom(address(this), finalOwner, id, value, "");
        return this.onERC1155Received.selector;
    }
}

contract FailingManagedLedgerFixture {
    uint256 public constant CLAIM_PERIOD = 30 days;
    bool private broken;
    bool private exhausted;
    uint64 public immutable end = uint64(block.timestamp + 1 days);

    function setFailure(bool fail) external {
        broken = fail;
    }

    function setExhaustion(bool fail) external { exhausted = fail; }

    function poolState(uint256) external view returns (UniversalRewards.PoolConfig memory, uint64, uint16, uint64, uint256) {
        return (UniversalRewards.PoolConfig(1, end, 0, 32, 32, ""), 1, 0, 0, 0);
    }

    function managedWeight(uint256, address) external pure returns (uint32) {
        return 1;
    }

    function updateManagedPosition(uint256, ManagedRewardPositions.PositionUpdate calldata update)
        external view returns (uint32)
    {
        require(!broken, "fixture ledger unavailable");
        if (exhausted) {
            assembly ("memory-safe") { invalid() }
        }
        return update.toWeight;
    }
}
