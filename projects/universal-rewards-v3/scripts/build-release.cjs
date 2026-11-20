const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { utils } = require('ethers')
const solc = require('solc')
const { compile } = require('./compile.cjs')
const { linkBytecode } = require('./link-bytecode.cjs')

const sha256 = (contents) => createHash('sha256').update(contents).digest('hex')
const serialize = (value) => JSON.stringify(value, null, 2) + '\n'
const polygonContracts = [
  'ManagedRewardPositions',
  'RewardSwapAdapter',
  'RewardRoutePlanner',
  'UniversalRewardsV33',
  'TreasuryVault',
  'ManagedNftCollection',
]
const isolatedContracts = ['FinalizedNftJournal', 'NftSourceJournal', 'FinalizedOwnershipVerifier']

function recordDeployment(artifact, links, code, address) {
  const runtime = artifact.evm.deployedBytecode
  const template = linkBytecode({ evm: { bytecode: runtime } }, links).slice(2)
  const observed = code.slice(2).toLowerCase()
  assert.equal(observed.length, template.length, 'Deployed runtime length')
  const slots = Object.values(runtime.immutableReferences).flat()
  for (const { start, length } of runtime.immutableReferences.library_deploy_address ?? []) {
    assert.equal(utils.getAddress('0x' + observed.slice((start + length - 20) * 2, (start + length) * 2)),
      utils.getAddress(address), 'Library runtime address')
  }
  // Solidity libraries encode their own address in the first PUSH20.
  if (template.startsWith('7300000000000000000000000000000000000000003014')) {
    assert.equal(observed.slice(2, 42), address.slice(2).toLowerCase(), 'Library call protection')
    slots.push({ start: 1, length: 20 })
  }
  const mask = (hex) => {
    const chars = [...hex]
    for (const { start, length } of slots) chars.fill('0', start * 2, (start + length) * 2)
    return chars.join('')
  }
  assert.equal(mask(observed), mask(template), 'Deployed runtime differs outside immutable slots')
  return {
    runtimeKeccak256: utils.keccak256(code),
    immutableValues: Object.fromEntries(Object.entries(runtime.immutableReferences).map(([id, references]) => [
      id,
      references.map(({ start, length }) => '0x' + observed.slice(start * 2, (start + length) * 2)),
    ])),
  }
}

function buildRelease(destination) {
  const write = (file, value) => {
    const contents = serialize(value)
    fs.writeFileSync(path.join(destination, file), contents)
    return sha256(contents)
  }
  fs.mkdirSync(path.join(destination, 'contracts'), { recursive: true })
  let inputHash
  const output = compile(undefined, (input) => { inputHash = write('standard-input.json', input) })
  const names = [...polygonContracts, ...isolatedContracts, 'UniversalRewards']
  const contracts = names.map((name) => {
    const source = 'contracts/' + name + '.sol'
    const { abi, evm, metadata } = output[source][name]
    const { object, linkReferences, immutableReferences } = evm.deployedBytecode
    const bytes = object.length / 2
    assert.ok(bytes > 0 && bytes <= 24_576, name + ' runtime size')
    const artifact = 'contracts/' + name + '.json'
    return {
      name, source, artifact, tier: polygonContracts.includes(name) ? 'polygon' : isolatedContracts.includes(name) ? 'isolated' : 'legacy',
      artifactSha256: write(artifact, { source, name, abi, evm, metadata: JSON.parse(metadata) }),
      abiSha256: sha256(serialize(abi)),
      creationTemplateSha256: sha256(evm.bytecode.object),
      runtimeTemplateSha256: sha256(object),
      runtimeBytes: bytes,
      runtimeLinkReferences: linkReferences,
      immutableReferences,
    }
  })
  write('manifest.json', {
    release: '3.5-rc', compiler: solc.version(), chainId: 137,
    packageLockSha256: sha256(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'))),
    standardInputSha256: inputHash,
    contracts,
  })
}

if (require.main === module) {
  const destination = process.argv[2]
  if (!destination) throw new Error('Usage: node scripts/build-release.cjs <output directory>')
  buildRelease(path.resolve(destination))
}

module.exports = { buildRelease, recordDeployment }
