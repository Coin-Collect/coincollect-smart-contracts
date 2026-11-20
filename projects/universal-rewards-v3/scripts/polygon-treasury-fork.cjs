const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Contract, ContractFactory, constants, utils } = require('ethers')
const { compile } = require('./compile.cjs')
const { linkBytecode } = require('./link-bytecode.cjs')
const { startLocalAnvil } = require('./local-anvil.cjs')
const { POLYGON_ROUTER, POLYGON_ASSETS, routerAbi } = require('./polygon-market.cjs')

const block = 97638790
const SOURCE = 'https://polygon.gateway.tenderly.co'
const QUICKSWAP = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'
const ROUTERS = [
  [QUICKSWAP, '0xf1ce1bb9d7403281292baa290f5c56136484cc34395dc3666ad7f94c79f99b71', '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32'],
  [POLYGON_ROUTER, '0x62983b1c9e3c0cece7438c16cf954aac862ba329b7d57e0e6cb886edc75e7363', '0x2bc17223A99B6e2857796a5F64A1ED91067b5657'],
]
const QUICK_PAIR = '0x5b83bdbcc56b2e630f2807bbadd2b0c21619108066b92a58de081261089e9ce5'
const COLLECT_PAIR = '0x693110e0dd495664e2e6bab84e8b7b5180d3fb2d7eeaf993214a9483c9c2f1ef'
const gas = { gasLimit: 8_000_000 }
const day = 86400
const zero = constants.AddressZero
const { USDT, WPOL, COLLECT, SHIB } = POLYGON_ASSETS
const usd = (value) => utils.parseUnits(String(value), 6)
const pol = (value) => utils.parseEther(String(value))

const v33 = (process.env.COINCOLLECT_V34_FIXTURE ?? process.env.COINCOLLECT_V33_FIXTURE) === '1'
test((v33 ? 'V3.4' : 'V3.2') + ' acquires WPOL, COLLECT and SHIB with real pinned router code and a 10 USDT lifetime budget', async (t) => {
  const upstream = process.env.COINCOLLECT_V3_POLYGON_RPC || SOURCE
  assert.equal(new URL(upstream).protocol, 'https:')
  const fork = await startLocalAnvil(['--fork-url', upstream, '--fork-block-number', String(block)])
  t.after(fork.close)
  const { provider } = fork
  assert.equal(await provider.send('eth_chainId', []), '0x7a69')
  assert.equal((await provider.getBlock(block)).hash, '0x9cf4791f6b4aab715d03aa5f66ad39e40676b80f00620927c6ddc6827db63419')
  const [operator, , user, executor] = await provider.listAccounts()
  const owner = operator
  const admin = provider.getSigner(operator)
  const treasurySigner = provider.getSigner(owner)
  const trader = provider.getSigner(executor)
  const entries = compile([
    v33 ? 'contracts/UniversalRewardsV33.sol' : 'contracts/UniversalRewards.sol',
    'contracts/RewardRoutePlanner.sol', 'test/Fixtures.sol',
  ])
  const links = {}
  const deploy = async (file, name, ...args) => {
    const artifact = entries[file][name]
    const contract = await (await new ContractFactory(artifact.abi, linkBytecode(artifact, links), admin).deploy(...args, gas)).deployed()
    links[file + ':' + name] = contract.address
    return contract
  }
  const send = async (tx) => (await tx).wait()
  const now = async () => (await provider.getBlock('latest')).timestamp
  const advance = async (time) => {
    await provider.send('evm_setNextBlockTimestamp', [time])
    await provider.send('evm_mine', [])
  }
  const hash = async (address) => utils.keccak256(await provider.getCode(address))
  const adapters = []
  for (const [router, routerHash, factory] of ROUTERS) {
    assert.equal(await hash(router), routerHash)
    adapters.push(await deploy('contracts/RewardSwapAdapter.sol', 'RewardSwapAdapter', operator, router, routerHash, factory, WPOL))
  }
  const [quick, coinCollect] = adapters
  const planner = await deploy('contracts/RewardRoutePlanner.sol', 'RewardRoutePlanner', operator, WPOL)
  for (const token of [USDT, WPOL, COLLECT, SHIB]) await send(planner.setAsset(token, true))
  for (const adapter of adapters) await send(planner.setAdapter(adapter.address, await hash(adapter.address)))

  const legs = [
    [quick, USDT, WPOL, '0x604229c960e5CACF2aaEAc8Be68Ac07BA9dF81c3', QUICK_PAIR, usd(10_000), pol(50_000)],
    [quick, WPOL, SHIB, '0x5FB641De2663e8a94C9dea0a539817850d996e99', QUICK_PAIR, pol(5_000), pol(10_000_000)],
    [quick, USDT, SHIB, '0xa09E6A33b1Ff289F7046B13D25e1659eC892eD58', QUICK_PAIR, usd(1), pol(100_000)],
    [coinCollect, WPOL, COLLECT, '0xFb09801B10298dB9663D2790F5D5Bc6aFa354497', COLLECT_PAIR, pol(1_000), pol(100_000)],
  ]
  for (const [adapter, input, output, pair, pairHash, minIn, minOut] of legs) {
    assert.equal(await hash(pair), pairHash)
    await send(adapter.configureRoute(input, output, pair, pairHash, minIn, minOut))
  }
  const direct = (adapter) => [adapter.address, zero, zero, true]
  await send(planner.configurePath(USDT, WPOL, 0, direct(quick)))
  await send(planner.configurePath(USDT, SHIB, 0, direct(quick)))
  await send(planner.configurePath(USDT, SHIB, 1, [quick.address, WPOL, quick.address, true]))
  await send(planner.configurePath(USDT, COLLECT, 0, [quick.address, WPOL, coinCollect.address, true]))
  await assert.rejects(planner.callStatic.configurePath(USDT, COLLECT, 1, [quick.address, USDT, coinCollect.address, true]))

  // Acquire the real stablecoin on the fork. The only upstream interaction is state reads.
  const tokenAbi = [
    'function balanceOf(address) view returns(uint256)',
    'function approve(address,uint256) returns(bool)',
    'function allowance(address,address) view returns(uint256)',
  ]
  const wrapped = new Contract(WPOL, [...tokenAbi, 'function deposit() payable'], treasurySigner)
  const stable = new Contract(USDT, tokenAbi, treasurySigner)
  const quickRouter = new Contract(QUICKSWAP, [...routerAbi, 'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns(uint256[])'], treasurySigner)
  await send(wrapped.deposit({ value: pol(300) }))
  await send(wrapped.approve(QUICKSWAP, pol(300)))
  await send(quickRouter.swapExactTokensForTokens(pol(300), usd(10), [WPOL, USDT], owner, (await now()) + 90, gas))
  assert.ok((await stable.balanceOf(owner)).gte(usd(10)))

  const observationGas = []
  for (const [adapter, input, output] of legs) {
    observationGas.push((await send(adapter.observe(input, output))).gasUsed.toNumber())
  }
  await advance((await now()) + 1800)
  for (const [adapter, input, output] of legs) {
    observationGas.push((await send(adapter.observe(input, output))).gasUsed.toNumber())
  }
  t.diagnostic(JSON.stringify({ observationGas, totalObservationGas: observationGas.reduce((sum, gas) => sum + gas, 0) }))
  await assert.rejects(planner.preview(USDT, COLLECT, usd(5), 0), { errorName: 'NoApprovedRoute' })
  assert.equal((await planner.bestRoute(USDT, SHIB, usd(2), 0)).index, 1)

  const nft = await deploy('test/Fixtures.sol', 'FixtureNft')
  if (v33) await deploy('contracts/ManagedRewardPositions.sol', 'ManagedRewardPositions')
  const ledger = v33
    ? await deploy('contracts/UniversalRewardsV33.sol', 'UniversalRewardsV33', operator, [USDT, WPOL, COLLECT, SHIB], WPOL, planner.address)
    : await deploy('contracts/UniversalRewards.sol', 'UniversalRewards', operator, owner, [USDT, WPOL, COLLECT, SHIB], WPOL, planner.address, zero)
  const vault = await deploy('contracts/TreasuryVault.sol', 'TreasuryVault', ledger.address)
  await send(ledger.connect(treasurySigner).attachTreasuryVault(vault.address))
  await assert.rejects(vault.connect(trader).callStatic.withdraw(USDT, usd(1)))
  await assert.rejects(planner.connect(trader).callStatic.setPaused(true))
  await send(stable.approve(vault.address, usd(10)))
  await send(vault.connect(treasurySigner).deposit(USDT, usd(10)))
  const start = (await now()) + 60
  const end = start + 365 * day
  const caps = []
  for (const [token, lifetime] of [[COLLECT, 5], [WPOL, 3], [SHIB, 2]]) {
    const tranche = usd(lifetime).mul(30).add(364).div(365)
    const [, floor] = await planner.preview(USDT, token, tranche, 0)
    caps.push([token, floor.mul(usd(lifetime)).div(tranche)])
  }
  await send(ledger.createTreasuryFundedPool(
    [start, end, 1, 2, 2, ''], [[137, nft.address, 1]], caps, [USDT, usd(10), 30 * day, [5000, 3000, 2000]],
    usd(10), false, gas,
  ))

  let totalSpent = constants.Zero
  for (const [token] of caps) {
    const [epoch, amount] = await ledger.nextReplenishment(1, token)
    const [index, quoted, minimum] = await planner.bestRoute(USDT, token, amount, 0)
    const receipt = await send(ledger.connect(trader).replenish(1, token, epoch, minimum, (await now()) + 90, gas))
    const result = receipt.events.find((event) => event.event === 'Replenished').args
    assert.ok(result.received.gte(minimum) && result.received.lte(quoted))
    assert.equal((await ledger.rewardState(1, token)).inventory.toString(), result.received.toString())
    assert.equal((await stable.allowance(ledger.address, planner.address)).toString(), '0')
    totalSpent = totalSpent.add(amount)
    t.diagnostic(`Token ${token} path ${index}, input ${utils.formatUnits(amount, 6)} USDT, gas ${receipt.gasUsed}, fee ${utils.formatEther(receipt.gasUsed.mul(receipt.effectiveGasPrice))} POL`)
  }
  assert.equal((await vault.balance(USDT)).spent.toString(), totalSpent.toString())
  assert.equal((await vault.balance(USDT)).allocated.toString(), usd(10).sub(totalSpent).toString())
  await send(nft.mint(user, 1))
  await advance(start)
  await send(ledger.connect(provider.getSigner(user)).join(1, 137, nft.address, 1, gas))
  await advance(start + day)
  await send(ledger.connect(provider.getSigner(user)).claim(1, 137, nft.address, 1, gas))
  for (const [token] of caps) assert.ok((await new Contract(token, tokenAbi, provider).balanceOf(user)).gt(0))
  await advance(end)
  await send(ledger.connect(trader).recoverBudget(1))
  assert.equal((await vault.balance(USDT)).available.toString(), usd(10).sub(totalSpent).toString())
  await advance(end + 30 * day)
  for (const [token] of caps) {
    await send(ledger.connect(trader).recoverExpiredRewards(1, token))
    assert.ok((await vault.balance(token)).rewardsReturned.gt(0))
    assert.equal((await ledger.rewardState(1, token)).inventory.toString(), '0')
  }
})
