const { constants, utils } = require('ethers')

const send = async (transaction) => (await transaction).wait()
const hash = async (provider, address) => utils.keccak256(await provider.getCode(address))
const evidence = utils.id('Isolated fixture review only')
const zero = constants.AddressZero

async function reviewAndApprove(registry, token, provider, decimals, permissions, implementation = zero) {
  await send(token.approve(registry.address, 1))
  const review = [
    await hash(provider, token.address), implementation,
    implementation === zero ? constants.HashZero : await hash(provider, implementation),
    evidence, decimals,
  ]
  await send(registry.reviewAsset(token.address, review, 1, permissions))
  return review
}

async function deployV36Core(deploy, admin, wrapped) {
  const file = (name) => 'contracts/v36/' + name + '.sol'
  const registry = await deploy('TreasuryAssetsV36', file('TreasuryAssetsV36'), admin)
  const planner = await deploy('RewardRoutePlannerV36', file('RewardRoutePlannerV36'), registry.address, wrapped)
  await deploy('ManagedRewardPositions', 'contracts/ManagedRewardPositions.sol')
  const ledger = await deploy('UniversalRewardsV36', file('UniversalRewardsV36'), planner.address)
  const vault = await deploy('TreasuryVaultV36', file('TreasuryVaultV36'), ledger.address)
  return { registry, planner, ledger, vault }
}

async function deployV36Market(deploy, provider, operator, wrapped, registry, planner) {
  const fixture = 'test/SwapFixtures.sol'
  const stable = await deploy('MarketTokenFixtureV36', 'test/TreasuryFixturesV36.sol', 6, 'V3USD')
  const nextToken = await deploy('MarketTokenFixtureV36', 'test/TreasuryFixturesV36.sol', 8, 'V3BTC')
  const factory = await deploy('FixtureSwapFactory', fixture)
  const router = await deploy('FixtureSwapRouter', fixture, factory.address, wrapped.address)
  const pair = await deploy('FixtureSwapPair', fixture, factory.address, wrapped.address, stable.address)
  const unit = utils.parseEther('1')
  const stableUnit = utils.parseUnits('1', 6)
  await send(wrapped.deposit({ value: unit.mul(1001) }))
  await send(wrapped.transfer(pair.address, unit.mul(1000)))
  await send(stable.mint(pair.address, stableUnit.mul(1000)))
  await send(stable.mint(operator, stableUnit.mul(100)))
  await send(nextToken.mint(operator, utils.parseUnits('100', 8)))
  await send(pair.setReserves(unit.mul(1000), stableUnit.mul(1000)))
  await send(factory.setPair(wrapped.address, stable.address, pair.address))
  const adapter = await deploy('RewardSwapAdapter', 'contracts/RewardSwapAdapter.sol',
    operator, router.address, await hash(provider, router.address), factory.address, wrapped.address)
  await reviewAndApprove(registry, wrapped, provider, 18, 7)
  await reviewAndApprove(registry, stable, provider, 6, 7)
  await send(planner.setAsset(wrapped.address, true))
  await send(planner.setAsset(stable.address, true))
  await send(planner.setAdapter(adapter.address, await hash(provider, adapter.address)))
  const pairHash = await hash(provider, pair.address)
  await send(adapter.configureRoute(wrapped.address, stable.address, pair.address, pairHash, unit.mul(100), stableUnit.mul(100)))
  await send(adapter.configureRoute(stable.address, wrapped.address, pair.address, pairHash, stableUnit.mul(100), unit.mul(100)))
  await send(planner.configurePath(wrapped.address, stable.address, 0, [adapter.address, zero, zero, true]))
  await send(planner.configurePath(stable.address, wrapped.address, 0, [adapter.address, zero, zero, true]))
  return { stable, nextToken, factory, router, pair, adapter }
}

async function refreshV36Market(provider, adapter, input, output) {
  const last = (await adapter.routeState(input, output)).sampleAt
  if (!last.isZero()) {
    const time = (await provider.getBlock('latest')).timestamp
    const gap = last.toNumber() + 7201 - time
    if (gap > 0) await provider.send('evm_increaseTime', [gap])
  }
  await send(adapter.observe(input, output))
  await send(adapter.observe(output, input))
  await provider.send('evm_increaseTime', [1801])
  await send(adapter.observe(input, output))
  await send(adapter.observe(output, input))
}

module.exports = { deployV36Core, deployV36Market, refreshV36Market, reviewAndApprove, hash, send }
