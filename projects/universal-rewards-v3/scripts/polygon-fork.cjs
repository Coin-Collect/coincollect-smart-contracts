const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Contract, ContractFactory, constants, utils } = require('ethers')
const { compile } = require('./compile.cjs')
const { startLocalAnvil } = require('./local-anvil.cjs')
const { POLYGON_ROUTER, POLYGON_ASSETS, routerAbi } = require('./polygon-market.cjs')

const block = 97638790
const blockHash = '0x9cf4791f6b4aab715d03aa5f66ad39e40676b80f00620927c6ddc6827db63419'
const routerHash = '0x62983b1c9e3c0cece7438c16cf954aac862ba329b7d57e0e6cb886edc75e7363'
const pairHash = '0x693110e0dd495664e2e6bab84e8b7b5180d3fb2d7eeaf993214a9483c9c2f1ef'
const expectedPair = '0xFb09801B10298dB9663D2790F5D5Bc6aFa354497'
const exactBlock = process.env.COINCOLLECT_V3_FORK_BLOCK ? Number(process.env.COINCOLLECT_V3_FORK_BLOCK) : block
const source = process.env.COINCOLLECT_V3_POLYGON_RPC || 'https://polygon.gateway.tenderly.co'
const gas = { gasLimit: 8_000_000 }

test('isolated Polygon fork executes reviewed WPOL to COLLECT route and real ERC-20 reward settlement', async (t) => {
  const upstream = new URL(source)
  assert.equal(upstream.protocol, 'https:')
  const fork = await startLocalAnvil(['--fork-url', source, '--fork-block-number', String(exactBlock)])
  t.after(fork.close)
  const { provider } = fork
  assert.equal(await provider.send('eth_chainId', []), '0x7a69')
  if (exactBlock === block) assert.equal((await provider.getBlock(block)).hash, blockHash)
  const [admin, user, treasury] = await provider.listAccounts()
  const signer = provider.getSigner(admin)
  const investor = provider.getSigner(user)
  const sourceRouter = new Contract(POLYGON_ROUTER, routerAbi, provider)
  const factoryAddress = await sourceRouter.factory()
  assert.equal(await sourceRouter.WETH(), utils.getAddress(POLYGON_ASSETS.WPOL))
  assert.equal(utils.keccak256(await provider.getCode(POLYGON_ROUTER)), routerHash)
  const factory = new Contract(factoryAddress, ['function getPair(address,address) view returns (address)'], provider)
  const pair = await factory.getPair(POLYGON_ASSETS.WPOL, POLYGON_ASSETS.COLLECT)
  assert.equal(pair, expectedPair)
  assert.equal(utils.keccak256(await provider.getCode(pair)), pairHash)

  const compiled = compile(['contracts/UniversalRewards.sol', 'test/Fixtures.sol'])
  const deploy = async (artifact, ...args) =>
    (await new ContractFactory(artifact.abi, '0x' + artifact.evm.bytecode.object, signer).deploy(...args, gas)).deployed()
  const send = async (pending) => (await pending).wait()
  const timestamp = async () => (await provider.getBlock('latest')).timestamp
  const at = async (time, submit) => {
    await provider.send('evm_setNextBlockTimestamp', [time])
    return send(submit())
  }

  const adapter = await deploy(
    compiled['contracts/RewardSwapAdapter.sol'].RewardSwapAdapter,
    admin, sourceRouter.address, routerHash, factoryAddress, POLYGON_ASSETS.WPOL,
  )
  await assert.rejects(adapter.callStatic.configureRoute(
    POLYGON_ASSETS.WPOL, POLYGON_ASSETS.SHIB, pair, pairHash, 1, 1,
  ))
  await send(adapter.configureRoute(
    POLYGON_ASSETS.WPOL, POLYGON_ASSETS.COLLECT, pair, pairHash,
    utils.parseEther('100'), utils.parseEther('10000'), gas,
  ))

  await send(adapter.observe(POLYGON_ASSETS.WPOL, POLYGON_ASSETS.COLLECT, gas))
  await at((await timestamp()) + 1800, () => adapter.observe(POLYGON_ASSETS.WPOL, POLYGON_ASSETS.COLLECT, gas))
  const nft = await deploy(compiled['test/Fixtures.sol'].FixtureNft)
  await send(nft.mint(user, 1, gas))
  const ledger = await deploy(
    compiled['contracts/UniversalRewards.sol'].UniversalRewards,
    admin, treasury, [POLYGON_ASSETS.WPOL, POLYGON_ASSETS.COLLECT], POLYGON_ASSETS.WPOL, adapter.address, constants.AddressZero,
  )
  const start = (await timestamp()) + 120
  const end = start + 18000
  const budget = utils.parseEther('0.1')
  await send(ledger.createPool([start, end, 0, 2, 3, ''], [[137, nft.address, 1]], [[POLYGON_ASSETS.COLLECT, utils.parseEther('100')]], gas))
  await send(ledger.configureFunding(1, POLYGON_ASSETS.WPOL, budget, 1800, [10000], gas))
  await send(ledger.fundBudget(1, budget, { ...gas, value: budget }))
  const { epoch, amount } = await ledger.nextReplenishment(1, POLYGON_ASSETS.COLLECT)
  assert.equal(epoch, 0)
  assert.equal(amount.toString(), utils.parseEther('0.01').toString())
  const quote = await adapter.preview(POLYGON_ASSETS.WPOL, POLYGON_ASSETS.COLLECT, amount, 0)
  const receipt = await send(ledger.connect(investor).replenish(
    1, POLYGON_ASSETS.COLLECT, epoch, quote.minimum, (await timestamp()) + 90, gas,
  ))
  const replenished = receipt.events.find(({ event }) => event === 'Replenished').args
  assert.equal(replenished.received.toString(), quote.quoted.toString())
  await at(start, () => ledger.connect(investor).join(1, 137, nft.address, 1, gas))
  const collect = new Contract(POLYGON_ASSETS.COLLECT, ['function balanceOf(address) view returns (uint256)'], provider)
  const before = await collect.balanceOf(user)
  await at(end + 1, () => ledger.connect(investor).exit(1, 137, nft.address, 1, gas))
  assert.equal((await collect.balanceOf(user)).sub(before).toString(), replenished.received.toString())
  assert.equal(await nft.ownerOf(1), user)
  t.diagnostic('Polygon fork block ' + exactBlock + ' route spent ' + utils.formatEther(amount) + ' WPOL, received and claimed '
    + utils.formatEther(replenished.received) + ' COLLECT')
})
