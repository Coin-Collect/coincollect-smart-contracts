// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UniversalRewards} from "../contracts/UniversalRewards.sol";
import {FixtureNft} from "./Fixtures.sol";

contract ScaleParticipant {
    constructor(UniversalRewards ledger, uint256 pool, FixtureNft collection, uint256 first, uint256 count) {
        UniversalRewards.NftRef[] memory positions = new UniversalRewards.NftRef[](count);
        for (uint256 i; i < count; ++i) {
            collection.mint(address(this), first + i);
            positions[i] = UniversalRewards.NftRef(137, address(collection), first + i);
        }
        ledger.joinBatch(pool, positions);
    }
}

contract ScaleFixtures {
    function populate(
        UniversalRewards ledger, uint256 pool, FixtureNft collection, uint256 first, uint256 wallets, uint256 perWallet
    ) external {
        for (uint256 i; i < wallets; ++i) {
            new ScaleParticipant(ledger, pool, collection, first + i * perWallet, perWallet);
        }
    }
}
