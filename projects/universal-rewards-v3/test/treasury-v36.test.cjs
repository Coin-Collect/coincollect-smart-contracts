const assert = require('node:assert/strict')
const { test } = require('node:test')
const { ContractFactory, constants, utils } = require('ethers')
const { compileV36 } = require('../scripts/compile-v36.cjs')
const { linkBytecode } = require('../scripts/link-bytecode.cjs')
const { startLocalAnvil } = require('../scripts/local-anvil.cjs')
const { deployV36Core, deployV36Market, refreshV36Market, reviewAndApprove, hash, send } = require('../scripts/v36-fixture.cjs')

const one = utils.parseEther('1')
const stableUnit = utils.parseUnits('1', 6)
const zero = constants.AddressZero

test('V3.6 Treasury assets, protected swaps and independent NFT obligations', async (t) => {
  const compiled = compileV36(['test/TreasuryFixturesV36.sol'])
  const local = await startLocalAnvil()
  t.after(local.close)
  const { provider } = local
  const [owner, alice] = await provider.listAccounts()
  const signer = provider.getSigner(owner)
  const links = {}
  const deploy = async (name, file, ...args) => {
    const artifact = compiled[file][name]
    const contract = await (await new ContractFactory(artifact.abi, linkBytecode(artifact, links), signer).deploy(...args)).deployed()
    links[file + ':' + name] = contract.address
    return contract
  }
  const fixtures = 'test/TreasuryFixturesV36.sol'
  const wrapped = await deploy('WrappedFixtureV36', fixtures)
  const { ledger, vault, planner, registry } = await deployV36Core(deploy, owner, wrapped.address)
  const { stable, nextToken, router, pair, adapter } = await deployV36Market(deploy, provider, owner, wrapped, registry, planner)
  const nft = await deploy('FixtureNft', 'test/Fixtures.sol')
  await send(nft.mint(alice, 1))
  const now = async () => (await provider.getBlock('latest')).timestamp
  const deadline = async () => (await now()) + 120
  const jump = async (time) => {
    await provider.send('evm_setNextBlockTimestamp', [time])
    await provider.send('evm_mine', [])
  }
  const available = async (token) => (await vault.balance(token.address)).available
  const equal = (a, b) => assert.equal(a.toString(), b.toString())
  const expectRevert = (result, errorName) => assert.rejects(result, (error) =>
    error.errorName === errorName || error.data === utils.id(errorName + '()').slice(0, 10))
  const scoped = async (name, run) => t.test(name, async () => {
    const snapshot = await provider.send('evm_snapshot', [])
    try { await run() } finally { await provider.send('evm_revert', [snapshot]) }
  })
  assert.ok((await provider.getCode(ledger.address)).length / 2 - 1 <= 24_576)
  await send(ledger.attachTreasuryVault(vault.address))
  await send(vault.deposit(wrapped.address, one.mul(20), { value: one.mul(20) }))

  await scoped('registration binds review, decimals, identity and exactly returned probe units', async () => {
    const input = {
      runtimeHash: await hash(provider, nextToken.address), implementation: zero,
      implementationHash: constants.HashZero, evidenceHash: utils.id('isolated token review'), decimals: 8,
    }
    const start = await nextToken.balanceOf(owner)
    await send(nextToken.approve(registry.address, 1))
    await expectRevert(registry.connect(provider.getSigner(alice)).callStatic.reviewAsset(nextToken.address, input, 1, 1), 'Unauthorized')
    for (const invalid of [
      { ...input, runtimeHash: constants.HashZero }, { ...input, decimals: 6 }, { ...input, evidenceHash: constants.HashZero },
    ]) await expectRevert(registry.callStatic.reviewAsset(nextToken.address, invalid, 1, 7), 'InvalidAssetReview')
    await expectRevert(registry.callStatic.reviewAsset(alice, input, 1, 7), 'InvalidAssetReview')
    await expectRevert(registry.callStatic.reviewAsset(nextToken.address, input, 0, 7), 'InvalidAssetReview')
    await send(registry.reviewAsset(nextToken.address, input, 1, 1))
    equal(await nextToken.balanceOf(owner), start)
    equal(await nextToken.balanceOf(registry.address), 0)
    equal(await nextToken.allowance(owner, registry.address), 0)
    assert.ok(await registry.permitted(nextToken.address, 1))
    assert.equal(await registry.permitted(nextToken.address, 2), false)
    assert.equal(await registry.permitted(nextToken.address, 4), false)
    assert.ok((await ledger.supportedAssets()).includes(nextToken.address))
    assert.equal(await ledger.supportedTokens(nextToken.address), false)
    await expectRevert(registry.callStatic.reviewAsset(nextToken.address, input, 1, 2), 'InvalidAssetReview')
    await send(registry.setPermissions(nextToken.address, 2))
    assert.equal(await registry.permitted(nextToken.address, 1), false)
    assert.ok(await ledger.supportedTokens(nextToken.address))
    await expectRevert(vault.callStatic.deposit(nextToken.address, 1), 'InvalidAsset')
    const startTime = await now() + 120
    const config = [startTime, startTime + 3600, 1, 3, 3, '']
    const collections = [[137, nft.address, 1]]
    await send(ledger.createPool(config, collections, [[nextToken.address, 100]]))
    await expectRevert(ledger.callStatic.createFundedPool(config, collections, [[nextToken.address, 100]], [nextToken.address, 100, 900, [10000]]), 'InvalidFundingPlan')
  })

  await scoped('supports each decimal scale from 0 through 36 and rejects larger scales', async () => {
    for (let scale = 0; scale <= 36; scale++) {
      const token = await deploy('FixtureToken', 'test/Fixtures.sol', scale)
      await send(token.mint(owner, 10))
      await reviewAndApprove(registry, token, provider, scale, 1)
      const [entry, valid] = await registry.assetState(token.address)
      assert.equal(entry.review.decimals, scale)
      assert.equal(valid, true)
      await send(token.approve(vault.address, 10))
      await send(vault.deposit(token.address, 10))
      equal(await available(token), 10)
      await send(vault.withdraw(token.address, 10))
      equal(await available(token), 0)
    }
    const unsupported = await deploy('FixtureToken', 'test/Fixtures.sol', 37)
    await expectRevert(registry.callStatic.reviewAsset(unsupported.address,
      [await hash(provider, unsupported.address), zero, constants.HashZero, utils.id('invalid test scale'), 37],
      1, 1), 'InvalidAssetReview')
  })

  await scoped('proxy identity drift stops new uses and re-review requires quarantine', async () => {
    const initial = await deploy('FixtureToken', 'test/Fixtures.sol', 6)
    const upgraded = await deploy('FixtureToken', 'test/Fixtures.sol', 6)
    const shell = await deploy('ProxyFixtureV36', fixtures, initial.address)
    const proxy = initial.attach(shell.address)
    await send(proxy.mint(owner, 1_000_000))
    await send(proxy.approve(registry.address, 2))
    const [runtime, evidence] = await Promise.all([hash(provider, proxy.address), Promise.resolve(utils.id('proxy exercise'))])
    await expectRevert(registry.callStatic.reviewAsset(proxy.address, [runtime, zero, constants.HashZero, evidence, 6], 1, 7), 'InvalidAssetReview')
    const reviewed = await reviewAndApprove(registry, proxy, provider, 6, 7, initial.address)
    await send(shell.upgradeFixture(upgraded.address))
    assert.equal(await registry.permitted(proxy.address, 4), false)
    const start = await now() + 30
    await expectRevert(ledger.callStatic.createPool(
      [start, start + 3600, 1, 2, 2, ''], [[137, nft.address, 1]], [[proxy.address, 1_000]],
    ), 'InvalidToken')
    await send(registry.setPermissions(proxy.address, 0))
    await reviewAndApprove(registry, proxy, provider, 6, 7, upgraded.address)
    assert.ok(await registry.permitted(proxy.address, 7))
    assert.notEqual(reviewed[1], upgraded.address)
  })

  await scoped('the exact round trip rejects transfer fees and later deposits remain exact', async () => {
    const token = await deploy('FeeTokenFixtureV36', fixtures)
    await send(token.mint(owner, 100))
    await send(token.approve(registry.address, 10))
    await send(token.setChargeFee(true))
    const input = [await hash(provider, token.address), zero, constants.HashZero, utils.id('fixture review'), 6]
    await expectRevert(registry.callStatic.reviewAsset(token.address, input, 10, 7), 'InexactAssetTransfer')
    await send(token.setChargeFee(false))
    await send(registry.reviewAsset(token.address, input, 10, 7))
    await send(token.approve(vault.address, 20))
    await send(vault.deposit(token.address, 10))
    await send(token.setChargeFee(true))
    await expectRevert(vault.callStatic.deposit(token.address, 10), 'InvalidTransfer')
    await expectRevert(vault.callStatic.withdraw(token.address, 10), 'InvalidTransfer')
    equal(await available(token), 10)
  })

  await scoped('protected swaps use available balances, exact units and zero residual allowances', async () => {
    const start = await now() + 20_000
    const input = one.mul(10)
    await send(ledger.createTreasuryFundedPool(
      [start, start + 3600, 1, 2, 2, ''], [[137, nft.address, 1]],
      [[wrapped.address, input]], [wrapped.address, input, 900, [10000]], input, true,
    ))
    // Physical balances in excess of available must not be used either.
    await send(wrapped.transfer(vault.address, one))
    await expectRevert(vault.callStatic.quoteTreasurySwap(wrapped.address, stable.address, input.add(1)), 'InsufficientAvailable')
    await expectRevert(vault.callStatic.quoteTreasurySwap(wrapped.address, stable.address, one), 'NoApprovedRoute')
    await refreshV36Market(provider, adapter, wrapped.address, stable.address)
    const [route, quote, floor] = await vault.quoteTreasurySwap(wrapped.address, stable.address, one)
    assert.ok(quote.gte(floor) && floor.gt(0))
    await expectRevert(vault.connect(provider.getSigner(alice)).callStatic.swapTreasury(wrapped.address, stable.address, route, one, floor, await deadline()), 'Unauthorized')
    await expectRevert(vault.callStatic.swapTreasury(wrapped.address, stable.address, route, one, 0, await deadline()), 'InvalidSwap')
    await expectRevert(vault.callStatic.swapTreasury(wrapped.address, stable.address, route, one, floor, await now() - 1), 'InvalidDeadline')
    await expectRevert(vault.callStatic.swapTreasury(wrapped.address, stable.address, route, one, floor, await now() + 301), 'InvalidDeadline')
    await send(router.setUnderpay(true))
    await assert.rejects(vault.swapTreasury(wrapped.address, stable.address, route, one, floor, await deadline(), { gasLimit: 5_000_000 }).then((transaction) => transaction.wait()))
    equal(await available(wrapped), input)
    equal((await vault.swapTotals(wrapped.address)).swappedOut, 0)
    await send(router.setUnderpay(false))
    const receipt = await send(vault.swapTreasury(wrapped.address, stable.address, route, one, floor, await deadline()))
    const event = receipt.events.find(({ event }) => event === 'TreasurySwap').args
    equal(event.amountIn, one)
    equal(await available(stable), event.amountOut)
    equal(await stable.balanceOf(vault.address), event.amountOut)
    equal(await available(wrapped), input.sub(one))
    equal((await vault.balance(wrapped.address)).allocated, input)
    equal(await wrapped.balanceOf(ledger.address), input)
    equal((await vault.swapTotals(wrapped.address)).swappedOut, one)
    equal((await vault.swapTotals(stable.address)).swappedIn, event.amountOut)
    for (const [authorizer, spender] of [[vault, planner], [planner, adapter], [adapter, router]]) {
      equal(await wrapped.allowance(authorizer.address, spender.address), 0)
    }
    const reverseInput = event.amountOut.div(2)
    const [back, , backFloor] = await vault.quoteTreasurySwap(stable.address, wrapped.address, reverseInput)
    await send(vault.swapTreasury(stable.address, wrapped.address, back, reverseInput, backFloor, await deadline()))
    equal(await available(stable), event.amountOut.sub(reverseInput))
    equal((await vault.swapTotals(stable.address)).swappedOut, reverseInput)
  })

  await scoped('quote fails for liquidity, stale observations, pause and permission changes', async () => {
    await refreshV36Market(provider, adapter, wrapped.address, stable.address)
    const [route, , minimum] = await vault.quoteTreasurySwap(wrapped.address, stable.address, one)
    await expectRevert(vault.callStatic.quoteTreasurySwap(wrapped.address, stable.address, one.mul(6)), 'NoApprovedRoute')
    await send(pair.setReserves(one.mul(90), stableUnit.mul(90)))
    await expectRevert(vault.callStatic.quoteTreasurySwap(wrapped.address, stable.address, one), 'NoApprovedRoute')
    await send(pair.setReserves(one.mul(1000), stableUnit.mul(1000)))
    await send(vault.setPaused(true))
    await expectRevert(vault.callStatic.swapTreasury(wrapped.address, stable.address, route, one, minimum, await deadline()), 'TreasuryPaused')
    await send(vault.setPaused(false))
    await send(registry.setPermissions(stable.address, 3))
    await expectRevert(vault.callStatic.swapTreasury(wrapped.address, stable.address, route, one, minimum, await deadline()), 'InvalidSwap')
    await send(registry.setPermissions(stable.address, 7))
    await jump(await now() + 7201)
    await expectRevert(vault.callStatic.quoteTreasurySwap(wrapped.address, stable.address, one), 'NoApprovedRoute')
  })

  await scoped('removed permissions preserve earned payouts and exact deadline recovery', async () => {
    await reviewAndApprove(registry, nextToken, provider, 8, 7)
    const budget = utils.parseUnits('20', 8)
    await send(nextToken.approve(vault.address, budget))
    await send(vault.deposit(nextToken.address, budget))
    const start = await now() + 60
    const end = start + 3600
    const settings = [start, end, 1, 2, 2, '']
    await send(ledger.createTreasuryFundedPool(settings, [[137, nft.address, 1]],
      [[nextToken.address, budget]], [nextToken.address, budget, 900, [10000]], budget, true))
    await send(registry.setPermissions(nextToken.address, 0))
    await expectRevert(ledger.callStatic.createPool(settings, [[137, nft.address, 1]], [[nextToken.address, budget]]), 'InvalidToken')
    await send(ledger.replenish(1, nextToken.address, 0, 0, await deadline()))
    await jump(start)
    const member = ledger.connect(provider.getSigner(alice))
    await send(member.join(1, 137, nft.address, 1))
    await jump(start + 300)
    await send(member.claim(1, 137, nft.address, 1))
    const paid = await nextToken.balanceOf(alice)
    assert.ok(paid.gt(0))
    await jump(end + 30 * 86400)
    await expectRevert(member.callStatic.claim(1, 137, nft.address, 1), 'ClaimPeriodEnded')
    await expectRevert(member.callStatic.exit(1, 137, nft.address, 1), 'ClaimPeriodEnded')
    await send(ledger.recoverExpiredRewards(1, nextToken.address))
    equal(await available(nextToken), budget.sub(paid))
    equal(await nextToken.balanceOf(vault.address), budget.sub(paid))
    equal((await vault.balance(nextToken.address)).allocated, 0)
    await send(vault.withdraw(nextToken.address, budget.sub(paid)))
    equal(await available(nextToken), 0)
  })

  await scoped('native POL unwrap is exact and rejects reentrant withdrawal by its owner', async () => {
    const ownerFixture = await deploy('NativeTreasuryOwnerFixtureV36', fixtures)
    const nativeRegistry = await deploy('TreasuryAssetsV36', 'contracts/v36/TreasuryAssetsV36.sol', ownerFixture.address)
    const nativePlanner = await deploy('RewardRoutePlannerV36', 'contracts/v36/RewardRoutePlannerV36.sol', nativeRegistry.address, wrapped.address)
    const nativeLedger = await deploy('UniversalRewardsV36', 'contracts/v36/UniversalRewardsV36.sol', nativePlanner.address)
    const nativeVault = await deploy('TreasuryVaultV36', 'contracts/v36/TreasuryVaultV36.sol', nativeLedger.address)
    await send(ownerFixture.execute(wrapped.address, wrapped.interface.encodeFunctionData('deposit'), { value: one }))
    await send(ownerFixture.execute(wrapped.address, wrapped.interface.encodeFunctionData('approve', [nativeRegistry.address, 1])))
    const review = [await hash(provider, wrapped.address), zero, constants.HashZero, utils.id('WPOL fixture review'), 18]
    await send(ownerFixture.execute(nativeRegistry.address, nativeRegistry.interface.encodeFunctionData('reviewAsset', [wrapped.address, review, 1, 7])))
    await send(ownerFixture.execute(nativeVault.address, nativeVault.interface.encodeFunctionData('deposit',
      [wrapped.address, one.mul(2)]), { value: one.mul(2) }))
    await send(ownerFixture.withdrawAndCheckGuard(nativeVault.address))
    assert.equal(await ownerFixture.callbackRejected(), true)
    equal((await nativeVault.balance(wrapped.address)).available, one)
    equal(await wrapped.balanceOf(nativeVault.address), one)
    equal(await provider.getBalance(ownerFixture.address), one)
  })
})
