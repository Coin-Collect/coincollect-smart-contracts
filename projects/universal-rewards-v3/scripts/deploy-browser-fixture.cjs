const { ContractFactory, providers, constants, utils } = require('ethers')
const { compile } = require('./compile.cjs')
const { compileV36 } = require('./compile-v36.cjs')
const { deployV36Core, deployV36Market } = require('./v36-fixture.cjs')
const { linkBytecode } = require('./link-bytecode.cjs')

async function main() {
  const url = new URL(process.env.COINCOLLECT_V3_LOCAL_RPC || 'http://127.0.0.1:18545')
  if (
    url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
  ) throw new Error('The browser fixture requires a loopback HTTP endpoint.')
  const provider = new providers.StaticJsonRpcProvider({ url: url.href, timeout: 1500 }, 31337)
  provider.pollingInterval = 50
  if (await provider.send('eth_chainId', []) !== '0x7a69') throw new Error('The fixture requires chain 31337.')
  await provider.send('anvil_nodeInfo', [])
  const [operator, participant] = await provider.listAccounts()
  const treasury = operator
  const signer = provider.getSigner(operator)
  const v36 = process.env.COINCOLLECT_V36_FIXTURE === '1'
  const v33 = v36 || (process.env.COINCOLLECT_V34_FIXTURE ?? process.env.COINCOLLECT_V33_FIXTURE) === '1'
  const entries = ['contracts/UniversalRewards.sol', 'test/Fixtures.sol', 'test/SwapFixtures.sol', 'test/ScaleFixtures.sol']
  if (v33) entries.push('contracts/ManagedNftCollection.sol', 'test/ManagedFixtures.sol')
  const compiled = v36 ? compileV36([...entries, 'test/TreasuryFixturesV36.sol']) : compile(entries)
  const links = {}
  const deploy = async (name, file, ...args) => {
    const artifact = compiled[file][name]
    const factory = new ContractFactory(artifact.abi, linkBytecode(artifact, links), signer)
    const component = await (await factory.deploy(...args)).deployed()
    links[file + ':' + name] = component.address
    return component
  }
  const nft = await deploy('FixtureNft', 'test/Fixtures.sol')
  const wrapped = v36
    ? await deploy('WrappedFixtureV36', 'test/TreasuryFixturesV36.sol')
    : await deploy('FixtureWrapped', 'test/SwapFixtures.sol')
  const core = v36 ? await deployV36Core(deploy, operator, wrapped.address) : undefined
  const market = core ? await deployV36Market(deploy, provider, operator, wrapped, core.registry, core.planner) : undefined
  if (v33 && !v36) await deploy('ManagedRewardPositions', 'contracts/ManagedRewardPositions.sol')
  const ledger = core?.ledger ?? (v33
    ? await deploy('UniversalRewardsV33', 'contracts/UniversalRewardsV33.sol',
        operator, [wrapped.address], wrapped.address, constants.AddressZero)
    : await deploy('UniversalRewards', 'contracts/UniversalRewards.sol',
        operator, treasury, [wrapped.address], wrapped.address, constants.AddressZero, constants.AddressZero))
  let managed
  if (v33) {
    const collection = await deploy('Hooked1155Fixture', 'test/ManagedFixtures.sol')
    const adapter = await deploy('ManagedNftCollection', 'contracts/ManagedNftCollection.sol',
      ledger.address, 137, collection.address, 1155, 25, constants.AddressZero)
    await (await collection.setHook(adapter.address)).wait()
    await (await ledger.approveManagedCollection(adapter.address)).wait()
    await (await collection.mint(participant, 25, 10)).wait()
    const plain = await deploy('Plain1155Fixture', 'test/ManagedFixtures.sol')
    managed = { collection: collection.address, adapter: adapter.address, tokenId: 25, plainCollection: plain.address }
  }
  const vault = core?.vault ?? await deploy('TreasuryVault', 'contracts/TreasuryVault.sol', ledger.address)
  await (await ledger.attachTreasuryVault(vault.address)).wait()
  const scaleFixture = await deploy('ScaleFixtures', 'test/ScaleFixtures.sol')

  await (await nft.mint(participant, 23)).wait()
  const now = (await provider.getBlock('latest')).timestamp
  const metadata = 'data:application/json;base64,' + Buffer.from(JSON.stringify({
    name: 'V3 Browser Fixture',
    description: 'A non-custodial ERC-721 pool for the browser acceptance test.',
  })).toString('base64')
  const budget = utils.parseEther('10')
  await (await ledger.createFundedPool(
    [now + 30, now + 18_030, 1, 2, 2, metadata],
    [[137, nft.address, 3]],
    [[wrapped.address, budget]],
    [wrapped.address, budget, 1800, [10000]],
  )).wait()
  await (await ledger.fundBudget(1, budget, { value: budget })).wait()
  await provider.send('evm_setNextBlockTimestamp', [now + 31])
  await provider.send('evm_mine', [])

  console.log(JSON.stringify({
    ledger: ledger.address,
    runtimeHash: utils.keccak256(await provider.getCode(ledger.address)),
    nft: nft.address,
    token: wrapped.address,
    operator,
    participant,
    treasury,
    treasuryVault: vault.address,
    scaleFixture: scaleFixture.address,
    version: v36 ? '3.6' : v33 ? '3.4' : '3.2',
    dynamic: market && {
      registry: core.registry.address, stable: market.stable.address,
      nextToken: market.nextToken.address, adapter: market.adapter.address,
    },
    managed,
    poolId: 1,
    tokenId: 23,
    end: now + 18_030,
  }, null, 2))
}

main().catch((error) => {
  console.error('Browser fixture setup failed: ' + (error.code || error.message))
  process.exitCode = 1
})
