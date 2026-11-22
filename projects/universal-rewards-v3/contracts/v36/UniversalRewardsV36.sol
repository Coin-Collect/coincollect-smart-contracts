// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UniversalRewardsV33} from "../UniversalRewardsV33.sol";
import {TreasuryVault} from "../TreasuryVault.sol";
import {RewardSwapAdapter} from "../RewardSwapAdapter.sol";
import {TreasuryAssetsV36} from "./TreasuryAssetsV36.sol";
import {RewardRoutePlannerV36} from "./RewardRoutePlannerV36.sol";
import {TreasuryVaultV36} from "./TreasuryVaultV36.sol";

/// @notice V3.5 settlement with live asset permission checks for newly configured pools.
contract UniversalRewardsV36 is UniversalRewardsV33 {
    TreasuryAssetsV36 public immutable registry;

    constructor(RewardRoutePlannerV36 planner)
        UniversalRewardsV33(planner.admin(), _bootstrap(planner.wrappedNative()), planner.wrappedNative(), RewardSwapAdapter(address(planner)))
    {
        registry = planner.registry();
    }

    function _bootstrap(address wrapped) private pure returns (address[] memory assets) {
        assets = new address[](1);
        assets[0] = wrapped;
    }

    function supportedAssets() external view override returns (address[] memory) {
        return registry.registeredAssets();
    }

    function _assetAllowed(address token, bool reward) internal view override returns (bool) {
        return registry.permitted(token, reward ? 2 : 1);
    }

    function _validateTreasury(TreasuryVault vault) internal view override {
        TreasuryVaultV36 candidate = TreasuryVaultV36(payable(address(vault)));
        if (candidate.registry() != registry || address(candidate.planner()) != address(swapAdapter)) {
            revert InvalidConfiguration();
        }
    }
}
