const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { compile } = require('./compile.cjs')

const entries = [
  'contracts/v36/UniversalRewardsV36.sol',
  'contracts/v36/TreasuryVaultV36.sol',
  'contracts/v36/RewardRoutePlannerV36.sol',
  'contracts/v36/TreasuryAssetsV36.sol',
  'contracts/ManagedNftCollection.sol',
]

function replaceAnchors(file, source, replacements) {
  for (const [before, after] of replacements) {
    assert.equal(source.split(before).length, 2, file + ' extension anchor changed: ' + before)
    source = source.replace(before, after)
  }
  return source
}

function extendFrozenSource(file, expectedSha256, replacements) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  assert.equal(createHash('sha256').update(source).digest('hex'), expectedSha256, file + ' frozen source changed')
  return replaceAnchors(file, source, replacements)
}

// V3.6.1 verifies the actual allowance before and after every swap-layer approval.
function allowanceChecks(token, spender, amount, error, indent = '        ') {
  return [amount, '0'].map((value) => {
    const line = `${token}.forceApprove(${spender}, ${value});`
    return [line, line + `
        if (${token}.allowance(address(this), ${spender}) != ${value}) revert ${error}();`]
  })
}

function compileV36(additionalEntries = [], exportInput, harden = true, { directTreasuryRewards = false, batchPositions = false, managedBatch = false, instantStart = false } = {}) {
  const ledger = 'contracts/UniversalRewards.sol'
  const planner = 'contracts/RewardRoutePlanner.sol'
  const sources = {
    [ledger]: extendFrozenSource(ledger, '70e04a306251fa3a0ad5fa33f7de8c69878810935fcba16daaa0ff28b12c59d5', [
      ['mapping(address => bool) public supportedTokens;', 'mapping(address => bool) private bootstrapTokens;'],
      ['supportedTokens[tokens[i]]) revert InvalidToken();', 'bootstrapTokens[tokens[i]]) revert InvalidToken();'],
      ['supportedTokens[tokens[i]] = true;', 'bootstrapTokens[tokens[i]] = true;'],
      ['!supportedTokens[wrapped]', '!bootstrapTokens[wrapped]'],
      ['!supportedTokens[reward.token]', '!_assetAllowed(reward.token, true)'],
      ['!supportedTokens[asset]', '!_assetAllowed(asset, false)'],
      // The V36 constructor selects V33's Polygon-only owner resolver, which always returns zero expiry.
      [' && (expiry == 0 || pool.remoteSeats.length < MAX_REMOTE_POSITIONS)', ''],
      [`        if (expiry != 0) {
            pool.remoteSeats.push(key);
            pool.remoteSlot[key] = uint8(pool.remoteSeats.length);
        }
`, ''],
      [`        if (position.seatExpiry != 0) {
            position.seatExpiry = 0;
            uint8 slot = pool.remoteSlot[key];
            bytes32 last = pool.remoteSeats[pool.remoteSeats.length - 1];
            pool.remoteSeats[slot - 1] = last;
            pool.remoteSlot[last] = slot;
            pool.remoteSeats.pop();
            delete pool.remoteSlot[key];
        }
`, ''],
      ['        treasuryVault = vault;', '        _validateTreasury(vault);\n        treasuryVault = vault;'],
      ['    function supportedAssets() external view returns (address[] memory) {', [
        '    function _validateTreasury(TreasuryVault) internal view virtual {}',
        '',
        '    function _assetAllowed(address token, bool) internal view virtual returns (bool) {',
        '        return bootstrapTokens[token];',
        '    }',
        '',
        '    function supportedTokens(address token) external view returns (bool) {',
        '        return _assetAllowed(token, true);',
        '    }',
        '',
        '    function supportedAssets() external view virtual returns (address[] memory) {',
      ].join('\n')],
    ]),
    [planner]: extendFrozenSource(planner, '5a97714f2765abb43e77b0ebac6763f31cbe6c9f93e399834d92d2737f7c9a95', [
      ['!approvedAsset[input] || !approvedAsset[output]', '!_assetAllowed(input) || !_assetAllowed(output)'],
      ['!approvedAsset[path.intermediate]', '!_assetAllowed(path.intermediate)'],
      ['    function _approved(RewardSwapAdapter adapter)', [
        '    function _assetAllowed(address token) internal view virtual returns (bool) {',
        '        return approvedAsset[token];',
        '    }',
        '',
        '    function _approved(RewardSwapAdapter adapter)',
      ].join('\n')],
    ]),
  }
  if (harden) {
    const vault = 'contracts/v36/TreasuryVaultV36.sol'
    const adapter = 'contracts/RewardSwapAdapter.sol'
    sources[vault] = extendFrozenSource(vault, 'ddbaf2fe712227c4f2a6836d7dff2edc53f110e3f38a91c39a42e0b2ffdac8e1',
      allowanceChecks('source', 'address(planner)', 'amount', 'InvalidTransfer'))
    sources[adapter] = extendFrozenSource(adapter, '996e8e4f028bd602c6e2267f6f127cfb54561a68e5a2169ff70e768636f539dc',
      allowanceChecks('asset', 'address(router)', 'amount', 'UnexpectedTransfer'))
    sources[ledger] = replaceAnchors(ledger, sources[ledger],
      allowanceChecks('source', 'address(swapAdapter)', 'amount', 'InvalidReceipt', '            '))
    sources[planner] = replaceAnchors(planner, sources[planner], [
      ...allowanceChecks('asset', 'address(adapter)', 'amount', 'UnexpectedTransfer'),
      ['        Path storage path = paths[input][output][index];\n        IERC20 reward', '        Path storage path = paths[input][output][index];\n        _validatePath(input, output, path);\n        IERC20 reward'],
    ])
  }
  if (directTreasuryRewards) {
    const oldReplenishment = sources[ledger].slice(
      sources[ledger].indexOf('    function _replenishment('),
      sources[ledger].indexOf('    function _intervalEmission('),
    )
    sources[ledger] = replaceAnchors(ledger, sources[ledger], [
      [
        'import {TreasuryVault} from "./TreasuryVault.sol";',
        'import {TreasuryVault} from "./TreasuryVault.sol";\nimport {TreasuryRewardFunding} from "./v37/TreasuryRewardFunding.sol";',
      ],
      [
        oldReplenishment,
        oldReplenishment.slice(0, oldReplenishment.indexOf('    {\n')) +
          '    {\n        return TreasuryRewardFunding.replenishment(pool, token, available, treasuryVault);\n    }\n\n',
      ],
      [
        '        poolId = _createPool(config, collections, rewards);\n        _configureFunding(poolId, funding.asset, funding.budget, funding.interval, funding.allocations);\n        Pool storage pool = pools[poolId];',
        [
          '        poolId = _createPool(config, collections, rewards);',
          '        if (funding.asset == address(0)) {',
          '            if (funding.budget != 0 || funding.interval != 0 || funding.allocations.length != 0',
          '                || initialAllocation != 0 || consolidated) revert InvalidFundingPlan();',
          '            _fundDirectTreasuryRewards(poolId, rewards);',
          '            return poolId;',
          '        }',
          '        _configureFunding(poolId, funding.asset, funding.budget, funding.interval, funding.allocations);',
          '        Pool storage pool = pools[poolId];',
        ].join('\n'),
      ],
      [
        '    function allocateTreasuryBudget(uint256 poolId, uint128 amount)',
        '    function _fundDirectTreasuryRewards(uint256, RewardConfig[] calldata) internal virtual { revert InvalidFundingPlan(); }\n\n    function allocateTreasuryBudget(uint256 poolId, uint128 amount)',
      ],
    ])
  }
  if (batchPositions) {
    sources[ledger] = replaceAnchors(ledger, sources[ledger], [
      [
        'import {TreasuryVault} from "./TreasuryVault.sol";',
        'import {TreasuryVault} from "./TreasuryVault.sol";\nimport {RewardTransferV38} from "./v38/RewardTransferV38.sol";',
      ],
      [
        `    function claim(uint256 poolId, uint256 sourceChainId, address collection, uint256 tokenId) external nonReentrant {
        (Pool storage pool, bytes32 key) = _ownedPosition(poolId, sourceChainId, collection, tokenId, true);
        for (uint256 i; i < pool.rewardTokens.length; ++i) _pay(poolId, pool, key, pool.rewardTokens[i]);
    }`,
        `    function claim(uint256 poolId, uint256 sourceChainId, address collection, uint256 tokenId) external nonReentrant {
        _claimOrExit(poolId, sourceChainId, collection, tokenId, false);
    }`,
      ],
      [
        `    function exit(uint256 poolId, uint256 sourceChainId, address collection, uint256 tokenId) external nonReentrant {
        _requireDirectCollection(collection);
        (Pool storage pool, bytes32 key) = _ownedPosition(poolId, sourceChainId, collection, tokenId, true);
        _leave(poolId, pool, key);
        for (uint256 i; i < pool.rewardTokens.length; ++i) _pay(poolId, pool, key, pool.rewardTokens[i]);
    }`,
        `    function exit(uint256 poolId, uint256 sourceChainId, address collection, uint256 tokenId) external nonReentrant {
        _claimOrExit(poolId, sourceChainId, collection, tokenId, true);
    }

    function _claimOrExit(uint256 poolId, uint256 sourceChainId, address collection, uint256 tokenId, bool exiting)
        internal
    {
        if (exiting) _requireDirectCollection(collection);
        (Pool storage pool, bytes32 key) = _ownedPosition(poolId, sourceChainId, collection, tokenId, true);
        if (exiting) _leave(poolId, pool, key);
        for (uint256 i; i < pool.rewardTokens.length; ++i) _pay(poolId, pool, key, pool.rewardTokens[i]);
    }`,
      ],
      [
        `    function _transferExact(address token, address receiver, uint256 amount) private {
        IERC20 asset = IERC20(token);
        uint256 beforePool = asset.balanceOf(address(this));
        uint256 beforeReceiver = asset.balanceOf(receiver);
        asset.safeTransfer(receiver, amount);
        if (beforePool - asset.balanceOf(address(this)) != amount || asset.balanceOf(receiver) - beforeReceiver != amount) {
            revert InvalidReceipt();
        }
    }`,
        `    function _transferExact(address token, address receiver, uint256 amount) private {
        RewardTransferV38.transferExact(token, receiver, amount);
    }`,
      ],
    ])
  }
  if (managedBatch) {
    const adapter = 'contracts/ManagedNftCollection.sol'
    sources[adapter] = extendFrozenSource(adapter, '196c8cc26fc2f6414f2f7dfae807c715a908cb6761c8f579c7cfac6ed5428b76', [
      [
        `        uint256 id = positionId(poolId, tokenId, msg.sender, false);
        if (IERC1155(sourceCollection).balanceOf(msg.sender, tokenId) < positions[id].entitled) revert InvalidQuantity();
        _release(poolId, tokenId, msg.sender, quantity, true);`,
        `        _exitLocal(poolId, tokenId, msg.sender, quantity);
    }

    function _exitLocal(uint256 poolId, uint256 tokenId, address owner, uint128 quantity) internal {
        uint256 id = positionId(poolId, tokenId, owner, false);
        if (IERC1155(sourceCollection).balanceOf(owner, tokenId) < positions[id].entitled) revert InvalidQuantity();
        _release(poolId, tokenId, owner, quantity, true);`,
      ],
    ])
  }
  if (instantStart) {
    sources[ledger] = replaceAnchors(ledger, sources[ledger], [
      [
        '        if (\n            config.start < block.timestamp || config.end <= config.start || config.end - config.start > 4 * 365 days',
        '        uint64 start = config.start == 0 ? uint64(block.timestamp) : config.start;\n        uint64 end = config.start == 0 ? start + config.end : config.end;\n        if (\n            start < block.timestamp || end <= start || end - start > 4 * 365 days',
      ],
      [
        '        pool.checkedUntil = config.start;',
        '        pool.config.start = start;\n        pool.config.end = end;\n        pool.checkedUntil = start;',
      ],
      [
        '        emit PoolCreated(poolId, config.start, config.end, config.metadataURI);',
        '        emit PoolCreated(poolId, start, end, config.metadataURI);',
      ],
      [
        '        if (msg.sender != admin) revert Unauthorized();\n        _configureFunding(poolId, asset, budget, interval, splits);',
        '        if (msg.sender != admin) revert Unauthorized();\n        if (block.timestamp >= _pool(poolId).config.start) revert InvalidFundingPlan();\n        _configureFunding(poolId, asset, budget, interval, splits);',
      ],
      [
        '|| block.timestamp >= pool.config.start || interval < MIN_REPLENISH_INTERVAL',
        '|| interval < MIN_REPLENISH_INTERVAL',
      ],
    ])
    const batchLedger = 'contracts/v38/UniversalRewardsV38.sol'
    sources[batchLedger] = extendFrozenSource(batchLedger, 'b4c26acb0e13f37d12bdadee6a2901c85f01a649da8937dc9e75da6f9666e8aa', [
      ['string public constant VERSION = "3.8.0";', 'function VERSION() external pure virtual returns (string memory) { return "3.8.0"; }'],
    ])
  }
  return compile([...entries, ...additionalEntries], exportInput, { sources, optimizerRuns: 1, evmVersion: 'shanghai' })
}

module.exports = { compileV36 }
