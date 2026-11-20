const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ContractFactory, constants, utils } = require('ethers')
const { compile } = require('../scripts/compile.cjs')
const { startLocalAnvil } = require('../scripts/local-anvil.cjs')

test('failed preferred swap rolls back and a second reviewed venue can execute exactly once', async (t) => {
  const chain = await startLocalAnvil()
  t.after(chain.close)
  const { provider } = chain
  const [admin, wallet] = await provider.listAccounts()
  const operator = provider.getSigner(admin)
  const participant = provider.getSigner(wallet)
  const entries = compile(['contracts/RewardRoutePlanner.sol', 'test/SwapFixtures.sol'])
  const deploy = async (file, name, ...args) => {
    const artifact = entries[file][name]
    return (await new ContractFactory(artifact.abi, '0x' + artifact.evm.bytecode.object, operator).deploy(...args)).deployed()
  }
  const fixture = (name, ...args) => deploy('test/SwapFixtures.sol', name, ...args)
  const send = async (tx) => (await tx).wait()
  const ethers = (value) => utils.parseEther(String(value))
  const hash = async (address) => utils.keccak256(await provider.getCode(address))
  const native = await fixture('FixtureWrapped')
  const reward = await deploy('test/Fixtures.sol', 'FixtureToken', 18)
  const routePlanner = await deploy('contracts/RewardRoutePlanner.sol', 'RewardRoutePlanner', admin, native.address)
  await send(routePlanner.setAsset(native.address, true))
  await send(routePlanner.setAsset(reward.address, true))

  const candidates = []
  for (const [index, reserveOut] of [[0, 10_000], [1, 9_900]]) {
    const factory = await fixture('FixtureSwapFactory')
    const router = await fixture('FixtureSwapRouter', factory.address, native.address)
    const pair = await fixture('FixtureSwapPair', factory.address, native.address, reward.address)
    await send(factory.setPair(native.address, reward.address, pair.address))
    await send(pair.setReserves(ethers(1000), ethers(reserveOut)))
    await send(reward.mint(pair.address, ethers(reserveOut)))
    const adapter = await deploy(
      'contracts/RewardSwapAdapter.sol', 'RewardSwapAdapter',
      admin, router.address, await hash(router.address), factory.address, native.address,
    )
    await send(adapter.configureRoute(native.address, reward.address, pair.address, await hash(pair.address), ethers(500), ethers(5000)))
    await send(routePlanner.setAdapter(adapter.address, await hash(adapter.address)))
    await send(routePlanner.configurePath(native.address, reward.address, index, [adapter.address, constants.AddressZero, constants.AddressZero, true]))
    await send(adapter.observe(native.address, reward.address))
    candidates.push({ router, pair, adapter })
  }
  await provider.send('evm_increaseTime', [1801])
  for (const { adapter } of candidates) await send(adapter.observe(native.address, reward.address))
  await send(native.mint(wallet, ethers(2)))
  await send(native.connect(participant).approve(routePlanner.address, ethers(2)))
  await send(candidates[0].router.setUnderpay(true))
  assert.equal((await routePlanner.bestRoute(native.address, reward.address, ethers(1), 0)).index, 0)
  const now = (await provider.getBlock('latest')).timestamp
  const receipt = await send(routePlanner.connect(participant).swapExact(
    native.address, reward.address, ethers(1), ethers(9), now + 90, { gasLimit: 3_000_000 },
  ))
  const traded = receipt.events.find((event) => event.event === 'Swapped').args
  assert.equal(traded.route, 1)
  assert.equal((await native.balanceOf(candidates[0].pair.address)).toString(), '0')
  assert.equal((await native.balanceOf(candidates[1].pair.address)).toString(), ethers(1).toString())
  assert.equal((await reward.balanceOf(wallet)).toString(), traded.received.toString())
  for (const { adapter } of candidates) {
    assert.equal((await native.allowance(routePlanner.address, adapter.address)).toString(), '0')
  }
  await send(candidates[1].router.setUnderpay(true))
  await assert.rejects(routePlanner.connect(participant).callStatic.swapExact(native.address, reward.address, ethers(1), 0, now + 90))
  assert.equal((await native.balanceOf(wallet)).toString(), ethers(1).toString())
  await send(routePlanner.setAsset(reward.address, false))
  await assert.rejects(routePlanner.callStatic.bestRoute(native.address, reward.address, ethers(1), 0))
})
