const fs = require('node:fs')
const path = require('node:path')
const solc = require('solc')

const root = path.resolve(__dirname, '..')

const releaseEntries = [
  'contracts/UniversalRewards.sol',
  'contracts/UniversalRewardsV33.sol',
  'contracts/ManagedNftCollection.sol',
  'contracts/FinalizedNftJournal.sol',
  'contracts/NftSourceJournal.sol',
  'contracts/RewardSwapAdapter.sol',
  'contracts/FinalizedOwnershipVerifier.sol',
  'contracts/TreasuryVault.sol',
  'contracts/RewardRoutePlanner.sol',
]

function compile(entries = releaseEntries, exportInput, { sources = {}, optimizerRuns = 200, evmVersion = 'paris' } = {}) {
  const readSource = (name, location) => sources[name] ?? fs.readFileSync(location, 'utf8')
  const imported = {}
  const input = {
    language: 'Solidity',
    sources: Object.fromEntries(entries.map((file) => [file, { content: readSource(file, path.join(root, file)) }])),
    settings: {
      optimizer: { enabled: true, runs: optimizerRuns },
      viaIR: true,
      evmVersion,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences', 'evm.deployedBytecode.object',
        'evm.deployedBytecode.linkReferences', 'evm.deployedBytecode.immutableReferences', 'metadata'] } },
    },
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input), {
    import: (name) => {
      const location = name.startsWith('@') ? path.join(root, 'node_modules', name) : path.join(root, name)
      try {
        const contents = readSource(name, location)
        imported[name] = { content: contents }
        return { contents }
      } catch {
        return { error: 'Unavailable import: ' + name }
      }
    },
  }))
  const errors = (output.errors || []).filter(({ severity }) => severity === 'error')
  if (errors.length) throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join('\n'))
  if (exportInput) {
    input.sources = Object.fromEntries(Object.entries({ ...input.sources, ...imported }).sort(([a], [b]) => a.localeCompare(b, 'en')))
    const reproduced = JSON.parse(solc.compile(JSON.stringify(input)))
    const failures = (reproduced.errors || []).filter(({ severity }) => severity === 'error')
    if (failures.length) throw new Error(failures.map(({ formattedMessage }) => formattedMessage).join('\n'))
    exportInput(input)
    return reproduced.contracts
  }
  return output.contracts
}

if (require.main === module) {
  const contracts = compile()
  for (const [file, implementations] of Object.entries(contracts)) {
    if (!file.startsWith('contracts/')) continue
    for (const [name, artifact] of Object.entries(implementations)) {
      const size = artifact.evm.deployedBytecode.object.length / 2
      if (!size) continue
      if (size > 24_576) throw new Error(name + ' exceeds the EIP-170 deployed runtime limit.')
      console.log(name + ': ' + size + ' runtime bytes')
    }
  }
}

module.exports = { compile }
