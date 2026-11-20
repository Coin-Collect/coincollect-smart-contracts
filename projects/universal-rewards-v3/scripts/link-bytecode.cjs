const { utils } = require('ethers')

function linkBytecode(artifact, addresses) {
  let bytecode = artifact.evm.bytecode.object
  for (const [file, libraries] of Object.entries(artifact.evm.bytecode.linkReferences)) {
    for (const [name, references] of Object.entries(libraries)) {
      const address = utils.getAddress(addresses[file + ':' + name]).slice(2).toLowerCase()
      for (const { start, length } of references) {
        if (length !== 20) throw Error('Unexpected Solidity library link length.')
        const offset = start * 2
        bytecode = bytecode.slice(0, offset) + address + bytecode.slice(offset + length * 2)
      }
    }
  }
  return '0x' + bytecode
}

module.exports = { linkBytecode }
