const fs = require('node:fs')
const path = require('node:path')
const solc = require('solc')

const root = path.resolve(__dirname, '..')

function compile(entries = ['contracts/UniversalRewards.sol']) {
  const input = {
    language: 'Solidity',
    sources: Object.fromEntries(entries.map((file) => [file, { content: fs.readFileSync(path.join(root, file), 'utf8') }])),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input), {
    import: (name) => {
      try {
        return { contents: fs.readFileSync(path.join(root, 'node_modules', name), 'utf8') }
      } catch {
        return { error: 'Unavailable import: ' + name }
      }
    },
  }))
  const errors = (output.errors || []).filter(({ severity }) => severity === 'error')
  if (errors.length) throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join('\n'))
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
