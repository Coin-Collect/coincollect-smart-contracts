const { ContractFactory, providers, constants, utils } = require('ethers')
const { compile } = require('./compile.cjs')

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
  const [operator, participant, , treasury] = await provider.listAccounts()
  const signer = provider.getSigner(operator)
  const compiled = compile(['contracts/UniversalRewards.sol', 'test/Fixtures.sol', 'test/SwapFixtures.sol'])
  const deploy = async (name, file, ...args) => {
    const artifact = compiled[file][name]
    const factory = new ContractFactory(artifact.abi, '0x' + artifact.evm.bytecode.object, signer)
    return (await factory.deploy(...args)).deployed()
  }
  const nft = await deploy('FixtureNft', 'test/Fixtures.sol')
  const wrapped = await deploy('FixtureWrapped', 'test/SwapFixtures.sol')
  const ledger = await deploy('UniversalRewards', 'contracts/UniversalRewards.sol',
    operator, treasury, [wrapped.address], wrapped.address, constants.AddressZero, constants.AddressZero)

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
    poolId: 1,
    tokenId: 23,
    end: now + 18_030,
  }, null, 2))
}

main().catch((error) => {
  console.error('Browser fixture setup failed: ' + (error.code || error.message))
  process.exitCode = 1
})
