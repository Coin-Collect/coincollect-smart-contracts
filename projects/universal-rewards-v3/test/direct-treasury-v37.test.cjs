const assert = require('node:assert/strict')
const { test } = require('node:test')
const { ContractFactory, constants, utils } = require('ethers')
const { compileV37, directTreasuryLedger, treasuryRewardFunding } = require('../scripts/compile-v37.cjs')
const { compileV38, batchLedger, rewardTransfer } = require('../scripts/compile-v38.cjs')
const { linkBytecode } = require('../scripts/link-bytecode.cjs')
const { startLocalAnvil } = require('../scripts/local-anvil.cjs')
const { deployV36Market, refreshV36Market, reviewAndApprove, send } = require('../scripts/v36-fixture.cjs')

const candidates = [
  { version: '3.7.0', compile: compileV37, ledgerName: 'UniversalRewardsV37', ledgerSource: directTreasuryLedger },
  { version: '3.8.0', compile: compileV38, ledgerName: 'UniversalRewardsV38', ledgerSource: batchLedger },
]

for (const { version, compile, ledgerName, ledgerSource } of candidates) {
  test(`V${version} Direct Treasury keeps atomic funding and reward recovery`, async (t) => {
    const fixtures = 'test/TreasuryFixturesV36.sol'
    const compiled = compile([fixtures])
    const local = await startLocalAnvil()
    t.after(local.close)
    const { provider } = local
    const [operator, participant] = await provider.listAccounts()
    const signer = provider.getSigner(operator)
    const links = {}
    const deploy = async (name, file, ...args) => {
      const artifact = compiled[file][name]
      const instance = await (await new ContractFactory(artifact.abi, linkBytecode(artifact, links), signer).deploy(...args)).deployed()
      links[file + ':' + name] = instance.address
      return instance
    }
    const wrapped = await deploy('WrappedFixtureV36', fixtures)
    const registry = await deploy('TreasuryAssetsV36', 'contracts/v36/TreasuryAssetsV36.sol', operator)
    const planner = await deploy('RewardRoutePlannerV36', 'contracts/v36/RewardRoutePlannerV36.sol', registry.address, wrapped.address)
    await deploy('ManagedRewardPositions', 'contracts/ManagedRewardPositions.sol')
    await deploy('TreasuryRewardFunding', treasuryRewardFunding)
    if (version === '3.8.0') await deploy('RewardTransferV38', rewardTransfer)
    const ledger = await deploy(ledgerName, ledgerSource, planner.address)
    const vault = await deploy('TreasuryVaultV36', 'contracts/v36/TreasuryVaultV36.sol', ledger.address)
    await send(ledger.attachTreasuryVault(vault.address))
    assert.ok(await ledger.DIRECT_TREASURY_REWARDS())
    if (version === '3.8.0') assert.equal(await ledger.VERSION(), version)
    else assert.equal(Object.keys(ledger.interface.functions).some((name) => name.startsWith('claimBatch(')), false)
    assert.ok(utils.hexDataLength(await provider.getCode(ledger.address)) <= 24_576)
    const { stable, nextToken, adapter } = await deployV36Market(deploy, provider, operator, wrapped, registry, planner)
    await reviewAndApprove(registry, nextToken, provider, 8, 3)
    const rewards = [
      [wrapped, utils.parseEther('2')],
      [stable, utils.parseUnits('3', 6)],
      [nextToken, utils.parseUnits('4', 8)],
    ]
    for (const [token, amount] of rewards) {
      const twice = amount.mul(2)
      if (token === wrapped) await send(vault.deposit(token.address, twice, { value: twice }))
      else {
        await send(token.approve(vault.address, twice))
        await send(vault.deposit(token.address, twice))
      }
    }
    const nft = await deploy('FixtureNft', 'test/Fixtures.sol')
    await send(nft.mint(participant, 1))
    const now = async () => (await provider.getBlock('latest')).timestamp
    const start = (await now()) + 120
    const config = [start, start + 86_400, 1, 20, 3, '']
    const rules = [[137, nft.address, 3]]
    const inventory = rewards.map(([token, cap]) => [token.address, cap])
    const noBudget = [constants.AddressZero, 0, 0, []]
    const create = (assets, funding = noBudget, actor = signer) =>
      ledger.connect(actor).createTreasuryFundedPool(config, rules, assets, funding, 0, false, { gasLimit: 2_500_000 })
    const books = async () => Promise.all(rewards.map(async ([token]) => {
      const book = await vault.balance(token.address)
      return {
        available: book.available.toString(),
        allocated: book.allocated.toString(),
        spent: book.spent.toString(),
        held: (await token.balanceOf(ledger.address)).toString(),
      }
    }))
    const before = await books()
    await assert.rejects(async () => send(create(inventory, noBudget, provider.getSigner(participant))))
    await assert.rejects(async () => send(create(inventory, [constants.AddressZero, 0, 15, []])))
    const tooMuch = [inventory[0], inventory[1], [nextToken.address, rewards[2][1].mul(3)]]
    await assert.rejects(async () => send(create(tooMuch)))
    await send(vault.setPaused(true))
    await assert.rejects(async () => send(create(inventory)))
    await send(vault.setPaused(false))
    assert.deepEqual(await books(), before)
    assert.equal(String(await ledger.poolCount()), '0')

    const receipt = await create(inventory).then((tx) => tx.wait())
    const funded = receipt.events.filter(({ event }) => event === 'RewardFunded')
    assert.equal(funded.length, 3)
    assert.equal(String(await ledger.poolCount()), '1')
    assert.equal((await ledger.fundingState(1)).asset, constants.AddressZero)
    assert.equal((await ledger.treasuryFunding(1)).treasuryBacked, true)
    for (const [token, amount] of rewards) {
      const pool = await ledger.rewardState(1, token.address)
      const book = await vault.balance(token.address)
      assert.ok(pool.cap.eq(amount) && pool.inventory.eq(amount))
      assert.ok(book.available.eq(amount) && book.allocated.isZero() && book.spent.eq(amount))
    }
    await provider.send('evm_setNextBlockTimestamp', [config[1] + 1])
    await provider.send('evm_mine', [])
    for (const [token, amount] of rewards) {
      await send(ledger.recoverSurplus(1, token.address))
      assert.ok((await ledger.rewardState(1, token.address)).inventory.isZero())
      const book = await vault.balance(token.address)
      assert.ok(book.available.eq(amount.mul(2)) && book.rewardsReturned.eq(amount))
    }

    await refreshV36Market(provider, adapter, wrapped.address, stable.address)
    const purchaseStart = (await now()) + 120
    const budget = utils.parseEther('1')
    const [, minimum] = await planner.bestRoute(wrapped.address, stable.address, budget, 0)
    await send(ledger.createTreasuryFundedPool(
      [purchaseStart, purchaseStart + 86_400, 1, 20, 3, ''],
      rules, [[stable.address, minimum]], [wrapped.address, budget, 1800, [10000]], budget, true,
    ))
    const next = await ledger.nextReplenishment(2, stable.address)
    assert.ok(next.amount.eq(budget))
    await send(ledger.replenish(2, stable.address, next.epoch, minimum, (await now()) + 120))
    assert.ok((await ledger.rewardState(2, stable.address)).inventory.gte(minimum))


    if (version !== '3.8.0') return

    await t.test('one Harvest and one Unstake pay every selected NFT and reward token', async () => {
      const walletLedger = ledger.connect(provider.getSigner(participant))
      const walletNft = nft.connect(provider.getSigner(participant))
      const refs = [1, 2, 3, 4].map((id) => [137, nft.address, id])
      for (const ref of refs.slice(1)) await send(nft.mint(participant, ref[2]))
      const limit = (await ledger.batchPositionLimit()).toNumber()
      const batchStart = (await now()) + 120
      await send(ledger.createTreasuryFundedPool(
        [batchStart, batchStart + 86_400, 1, 20, limit, ''], rules, inventory, noBudget, 0, false,
      ))
      const poolId = await ledger.poolCount()
      await provider.send('evm_setNextBlockTimestamp', [batchStart])
      await send(walletLedger.joinBatch(poolId, refs))
      await send(walletNft.transferFrom(participant, operator, 4))
      await provider.send('evm_setNextBlockTimestamp', [batchStart + 600])
      await provider.send('evm_mine', [])

      const walletBalances = () => Promise.all(rewards.map(([token]) => token.balanceOf(participant)))
      // Match Studio's gas headroom when a payout can change between estimation and mining.
      const settle = async (actor, method, args, positions) => {
        const estimate = await actor.estimateGas[method](...args)
        return send(actor[method](...args, { gasLimit: estimate.add(estimate.div(5)).add(25_000 + positions * 150_000) }))
      }
      const assertPayouts = async (receipt, previous, count) => {
        assert.equal(receipt.status, 1)
        const events = receipt.events.filter(({ event }) => event === 'Claimed')
        assert.equal(new Set(events.map(({ args }) => args.nft)).size, count)
        assert.equal(events.length, count * rewards.length)
        const balances = await walletBalances()
        for (const [index, [token]] of rewards.entries()) {
          const paid = events.filter(({ args }) => args.token === token.address && args.owner === participant)
            .reduce((total, { args }) => total.add(args.amount), constants.Zero)
          assert.ok(paid.gt(0))
          assert.ok(balances[index].sub(previous[index]).eq(paid))
        }
      }

      const beforeHarvest = await walletBalances()
      const harvest = await settle(walletLedger, 'claimBatch', [poolId, refs.slice(0, 3)], 3)
      await assertPayouts(harvest, beforeHarvest, 3)
      assert.equal((await ledger.walletsNftCount(poolId, participant)).toNumber(), 4)

      await provider.send('evm_setNextBlockTimestamp', [batchStart + 1_200])
      await provider.send('evm_mine', [])
      const beforeExit = await walletBalances()
      const firstKey = await ledger.nftKey(...refs[0])
      await assert.rejects(walletLedger.callStatic.claimBatch(poolId, []))
      await assert.rejects(walletLedger.callStatic.exitBatch(poolId, Array(limit + 1).fill(refs[0])))
      await assert.rejects(async () => send(walletLedger.exitBatch(poolId, [refs[0], refs[3]], { gasLimit: 2_000_000 })))
      assert.deepEqual(await walletBalances(), beforeExit)
      assert.equal((await ledger.positionState(poolId, firstKey)).seatOwner, participant)

      const unstake = await settle(walletLedger, 'exitBatch', [poolId, refs.slice(0, 2)], 2)
      await assertPayouts(unstake, beforeExit, 2)
      assert.equal(unstake.events.filter(({ event }) => event === 'SeatChanged').length, 2)
      assert.equal((await ledger.walletsNftCount(poolId, participant)).toNumber(), 2)
      for (const ref of refs.slice(0, 3)) assert.equal(await nft.ownerOf(ref[2]), participant)
      const remainingKey = await ledger.nftKey(...refs[2])
      assert.equal((await ledger.positionState(poolId, remainingKey)).seatOwner, participant)
      const retry = await settle(walletLedger, 'exitBatch', [poolId, refs.slice(0, 2)], 2)
      assert.equal(retry.events.filter(({ event }) => event === 'Claimed' || event === 'SeatChanged').length, 0)

      await settle(ledger, 'exit', [poolId, ...refs[3]], 1)
      const additional = Array.from({ length: limit - 1 }, (_, index) => [137, nft.address, index + 5])
      for (const ref of additional) await send(nft.mint(participant, ref[2]))
      await send(walletLedger.joinBatch(poolId, additional))
      await provider.send('evm_setNextBlockTimestamp', [batchStart + 2_400])
      await provider.send('evm_mine', [])
      const all = [refs[2], ...additional]
      const beforeMaxHarvest = await walletBalances()
      const maxHarvest = await settle(walletLedger, 'claimBatch', [poolId, all], all.length)
      await assertPayouts(maxHarvest, beforeMaxHarvest, limit)
      await provider.send('evm_setNextBlockTimestamp', [batchStart + 3_600])
      await provider.send('evm_mine', [])
      const beforeMaxExit = await walletBalances()
      const maxExit = await settle(walletLedger, 'exitBatch', [poolId, all], all.length)
      await assertPayouts(maxExit, beforeMaxExit, limit)
      assert.equal((await ledger.walletsNftCount(poolId, participant)).toNumber(), 0)
      assert.equal((await ledger.poolState(poolId)).activeNfts.toNumber(), 0)
      t.diagnostic(`${limit} NFT and ${rewards.length} token settlement: ${maxHarvest.gasUsed} gas for Harvest, ${maxExit.gasUsed} for Unstake`)
    })
  })
}
