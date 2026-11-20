const { before, after, test } = require('node:test')
const assert = require('node:assert/strict')
const { ContractFactory, constants, utils } = require('ethers')
const { compile } = require('../scripts/compile.cjs')
const { startLocalAnvil } = require('../scripts/local-anvil.cjs')

const gas = { gasLimit: 8_000_000 }
const unit = 10n ** 18n
const fundingBudget = 1000n * unit
const interval = 1800
const duration = interval * 10
const inputReserve = 1_000_000n * unit
const outputReserve = 2_000_000n * unit
let chain, operator, executor, accounts, rewards, wrapped, nft, swap, router, pair

async function deploy(artifact, ...args) {
  return (await new ContractFactory(artifact.abi, '0x' + artifact.evm.bytecode.object, operator).deploy(...args)).deployed()
}

async function now() {
  return (await chain.provider.getBlock('latest')).timestamp
}

async function at(time, send) {
  await chain.provider.send('evm_setNextBlockTimestamp', [time])
  if (send) return (await send()).wait()
  return chain.provider.send('evm_mine', [])
}

async function transact(send) {
  return (await send).wait()
}

async function makePool(assets = [wrapped.address, rewards.address], splits = [5000, 5000]) {
  const start = (await now()) + 100
  const end = start + duration
  const ledger = makePool.ledger
  const receipt = await transact(ledger.createPool(
    [start, end, 0, 2, 3, 'ipfs://funding-fixture'],
    [[137, nft.address, 1]],
    assets.map((asset) => [asset, 1000n * unit]),
  ))
  const poolId = receipt.events.find(({ event }) => event === 'PoolCreated').args.poolId
  await transact(ledger.configureFunding(poolId, wrapped.address, fundingBudget, interval, splits))
  return { poolId, start, end, ledger }
}

async function balances(token, ...addresses) {
  return Promise.all(addresses.map(async (address) => (await token.balanceOf(address)).toBigInt()))
}

async function observe() {
  await transact(swap.observe(wrapped.address, rewards.address, gas))
}

before(async () => {
  const entries = compile(['contracts/UniversalRewards.sol', 'test/Fixtures.sol', 'test/SwapFixtures.sol'])
  const { FixtureToken, FixtureNft } = entries['test/Fixtures.sol']
  const { FixtureWrapped, FixtureSwapFactory, FixtureSwapPair, FixtureSwapRouter } = entries['test/SwapFixtures.sol']
  chain = await startLocalAnvil()
  accounts = await chain.provider.listAccounts()
  operator = chain.provider.getSigner(accounts[0])
  executor = chain.provider.getSigner(accounts[1])
  wrapped = await deploy(FixtureWrapped)
  rewards = await deploy(FixtureToken, 18)
  nft = await deploy(FixtureNft)
  const factory = await deploy(FixtureSwapFactory)
  // The input is token1 here to exercise the reverse cumulative price.
  pair = await deploy(FixtureSwapPair, factory.address, rewards.address, wrapped.address)
  router = await deploy(FixtureSwapRouter, factory.address, wrapped.address)
  await transact(factory.setPair(wrapped.address, rewards.address, pair.address))
  await transact(pair.setReserves(outputReserve, inputReserve))
  await transact(rewards.mint(pair.address, outputReserve))
  await transact(wrapped.mint(pair.address, inputReserve))
  const hash = async (contract) => utils.keccak256(await chain.provider.getCode(contract.address))
  const swapArtifact = entries['contracts/RewardSwapAdapter.sol'].RewardSwapAdapter
  await assert.rejects(deploy(swapArtifact, accounts[0], router.address, constants.HashZero, factory.address, wrapped.address))
  swap = await deploy(swapArtifact, accounts[0], router.address, await hash(router), factory.address, wrapped.address)
  await assert.rejects(swap.connect(executor).callStatic.configureRoute(
    wrapped.address, rewards.address, pair.address, await hash(pair), unit, unit,
  ))
  await transact(swap.configureRoute(wrapped.address, rewards.address, pair.address, await hash(pair), inputReserve / 2n, outputReserve / 2n))
  makePool.ledger = await deploy(
    entries['contracts/UniversalRewards.sol'].UniversalRewards,
    accounts[0],
    accounts[2],
    [wrapped.address, rewards.address],
    wrapped.address,
    swap.address,
  )
})

after(() => chain?.close())

test('bounded replenishment for native POL and two reward allocations is replay-safe and preserves liabilities', async () => {
  const { poolId, start, end, ledger } = await makePool()
  await assert.rejects(ledger.callStatic.fundBudget(poolId, fundingBudget, { value: fundingBudget - 1n }))
  await transact(ledger.fundBudget(poolId, fundingBudget, { value: fundingBudget }))
  await assert.rejects(ledger.callStatic.fundBudget(poolId, 1, { value: 1 }))
  assert.equal((await ledger.fundingState(poolId)).deposited.toBigInt(), fundingBudget)
  const budgets = await Promise.all([wrapped, rewards].map((token) => ledger.nextReplenishment(poolId, token.address)))
  assert.deepEqual(budgets.map((item) => [item.epoch, item.amount.toBigInt()]), [[0, 50n * unit], [0, 50n * unit]])

  await assert.rejects(ledger.connect(executor).callStatic.replenish(poolId, rewards.address, 0, 0, start))
  const [wrappedBefore, rewardBefore] = await Promise.all([wrapped, rewards].map((token) => balances(token, ledger.address)))
  assert.deepEqual([wrappedBefore[0], rewardBefore[0]], [fundingBudget, 0n])
  assert.equal((await ledger.fundingState(poolId)).spent.toBigInt(), 0n)

  // Warm a direct-price oracle using unchanged pair reserves for the full observation interval.
  await observe()
  const sample = (await swap.routeState(wrapped.address, rewards.address)).sampleAt.toNumber()
  await assert.rejects(swap.callStatic.observe(wrapped.address, rewards.address))
  await at(sample + interval, () => swap.observe(wrapped.address, rewards.address, gas))
  const chainTime = await now()
  const epoch = (await ledger.nextReplenishment(poolId, rewards.address)).epoch
  assert.equal(epoch, 1)
  const deadline = chainTime + 120

  await assert.rejects(ledger.connect(executor).callStatic.replenish(poolId, rewards.address, 0, 0, deadline))
  await transact(ledger.setFundingPaused(poolId, true))
  assert.equal((await ledger.nextReplenishment(poolId, rewards.address)).amount.toBigInt(), 0n)
  await assert.rejects(ledger.connect(executor).callStatic.replenish(poolId, rewards.address, epoch, 0, deadline))
  await transact(ledger.setFundingPaused(poolId, false))
  await assert.rejects(ledger.connect(executor).callStatic.replenish(poolId, rewards.address, epoch, 0, deadline + 500))
  const quote = await swap.preview(wrapped.address, rewards.address, 50n * unit, 0)
  assert.ok(quote.quoted.toBigInt() > 99n * unit)
  await assert.rejects(ledger.connect(executor).callStatic.replenish(poolId, rewards.address, epoch, quote.quoted.add(1), deadline))

  await transact(router.setUnderpay(true))
  await assert.rejects(ledger.connect(executor).callStatic.replenish(poolId, rewards.address, epoch, 0, deadline))
  assert.equal((await ledger.fundingState(poolId)).spent.toBigInt(), 0n)
  assert.equal((await ledger.fundingLane(poolId, rewards.address)).purchased, false)
  await transact(router.setUnderpay(false))

  await transact(ledger.connect(executor).replenish(poolId, wrapped.address, epoch, 0, deadline))
  const receipt = await transact(ledger.connect(executor).replenish(poolId, rewards.address, epoch, quote.minimum, deadline))
  const executed = receipt.events.find(({ event }) => event === 'Replenished').args
  assert.equal(executed.epoch, epoch)
  assert.equal(executed.spent.toBigInt(), 50n * unit)
  assert.equal(executed.received.toBigInt(), quote.quoted.toBigInt())
  await assert.rejects(ledger.connect(executor).callStatic.replenish(poolId, rewards.address, epoch, 0, deadline))
  assert.equal((await ledger.fundingState(poolId)).spent.toBigInt(), 100n * unit)
  assert.equal((await wrapped.allowance(ledger.address, swap.address)).toBigInt(), 0n)
  assert.equal((await wrapped.allowance(swap.address, router.address)).toBigInt(), 0n)
  assert.equal((await ledger.rewardState(poolId, wrapped.address)).inventory.toBigInt(), 50n * unit)
  assert.equal((await ledger.rewardState(poolId, rewards.address)).inventory.toBigInt(), executed.received.toBigInt())

  await transact(nft.mint(accounts[1], 1))
  await transact(ledger.connect(executor).join(poolId, nft.address, 1, gas))
  assert.ok((await now()) < end)
  const treasury = accounts[2]
  const [treasuryBefore] = await balances(wrapped, treasury)
  await assert.rejects(ledger.callStatic.recoverBudget(poolId))
  await at(end + 1, () => ledger.connect(executor).recoverBudget(poolId, gas))
  assert.equal((await balances(wrapped, treasury))[0] - treasuryBefore, 900n * unit)
  assert.equal((await ledger.callStatic.recoverBudget(poolId)).toBigInt(), 0n)
  assert.equal((await ledger.callStatic.recoverSurplus(poolId, wrapped.address)).toBigInt(), 0n)
  await transact(ledger.connect(executor).exit(poolId, nft.address, 1, gas))
  assert.equal((await balances(wrapped, accounts[1]))[0], 50n * unit)
  assert.equal((await balances(rewards, accounts[1]))[0], executed.received.toBigInt())
})

test('adapter fails closed on stale, manipulated, paused and shallow routes', async () => {
  const input = wrapped.address
  const output = rewards.address
  await assert.rejects(swap.preview(input, output, unit, 0))
  await transact(pair.setReserves(outputReserve, inputReserve, gas))
  await observe()
  const sample = (await swap.routeState(input, output)).sampleAt.toNumber()
  await at(sample + interval, () => swap.observe(input, output, gas))
  assert.ok((await swap.preview(input, output, unit, 0)).minimum.gt(0))
  await assert.rejects(swap.preview(input, output, inputReserve / 100n, 0))

  await transact(pair.setReserves(outputReserve * 2n, inputReserve, gas))
  await assert.rejects(swap.preview(input, output, unit, 0))
  await transact(pair.setReserves(outputReserve, inputReserve / 10n, gas))
  await assert.rejects(swap.preview(input, output, unit, 0))
  await transact(pair.setReserves(outputReserve, inputReserve, gas))
  assert.ok((await swap.preview(input, output, unit, 0)).minimum.gt(0))

  await assert.rejects(swap.connect(executor).callStatic.setPaused(true))
  await transact(swap.setPaused(true))
  await assert.rejects(swap.preview(input, output, unit, 0))
  await transact(swap.setPaused(false))
  const average = (await swap.routeState(input, output)).averageAt.toNumber()
  await at(average + 7201)
  await assert.rejects(swap.preview(input, output, unit, 0))
  await assert.rejects(swap.preview(output, input, unit, 0))
})

test('partial ERC-20 deposits honor allocation floors and isolate independently funded pools', async () => {
  const first = await makePool([wrapped.address], [10000])
  const second = await makePool([wrapped.address], [10000])
  const { ledger } = first
  const amount = 20n * unit
  await transact(wrapped.mint(accounts[0], 2n * amount))
  await transact(wrapped.approve(ledger.address, 2n * amount))
  await transact(ledger.fundBudget(first.poolId, amount))
  await transact(ledger.fundBudget(second.poolId, amount))
  const current = await now()
  await transact(ledger.connect(executor).replenish(first.poolId, wrapped.address, 0, amount, current + 120))
  assert.equal((await ledger.fundingState(first.poolId)).spent.toBigInt(), amount)
  assert.equal((await ledger.rewardState(first.poolId, wrapped.address)).inventory.toBigInt(), amount)
  assert.equal((await ledger.fundingState(second.poolId)).spent.toBigInt(), 0n)
  assert.equal((await ledger.rewardState(second.poolId, wrapped.address)).inventory.toBigInt(), 0n)
})
