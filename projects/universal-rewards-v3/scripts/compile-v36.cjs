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

function compileV36(additionalEntries = [], exportInput, harden = true) {
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
  return compile([...entries, ...additionalEntries], exportInput, { sources, optimizerRuns: 1, evmVersion: 'shanghai' })
}

module.exports = { compileV36 }
