// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {FixtureToken} from "./Fixtures.sol";
import {FixtureWrapped} from "./SwapFixtures.sol";

contract WrappedFixtureV36 is FixtureWrapped {
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool sent,) = msg.sender.call{value: amount}("");
        require(sent);
    }
}

contract MarketTokenFixtureV36 is FixtureToken {
    string private ticker;

    constructor(uint8 scale, string memory tokenSymbol) FixtureToken(scale) {
        ticker = tokenSymbol;
    }

    function symbol() public view override returns (string memory) {
        return ticker;
    }
}

contract FeeTokenFixtureV36 is FixtureToken {
    bool public chargeFee;

    constructor() FixtureToken(6) {}

    function setChargeFee(bool enabled) external {
        chargeFee = enabled;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (chargeFee && from != address(0) && to != address(0)) {
            super._update(from, address(0), 1);
            --amount;
        }
        super._update(from, to, amount);
    }
}

contract ProxyFixtureV36 is ERC1967Proxy {
    address private immutable upgradeAdmin;

    constructor(address initial) ERC1967Proxy(initial, "") {
        upgradeAdmin = msg.sender;
    }

    function implementation() external view returns (address) {
        return ERC1967Utils.getImplementation();
    }

    function upgradeFixture(address next) external {
        require(msg.sender == upgradeAdmin);
        ERC1967Utils.upgradeToAndCall(next, "");
    }
}

interface INativeTreasury {
    function withdrawNative(uint256 amount) external;
}

contract NativeTreasuryOwnerFixtureV36 {
    bool public callbackRejected;
    INativeTreasury private vault;

    function execute(address target, bytes calldata data) external payable {
        (bool ok, bytes memory reason) = target.call{value: msg.value}(data);
        if (!ok) assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
    }

    function withdrawAndCheckGuard(INativeTreasury treasury) external {
        vault = treasury;
        treasury.withdrawNative(1 ether);
    }

    receive() external payable {
        try vault.withdrawNative(1 ether) {
            revert("fixture: reentrancy was accepted");
        } catch (bytes memory reason) {
            callbackRejected = bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()"));
        }
    }
}
