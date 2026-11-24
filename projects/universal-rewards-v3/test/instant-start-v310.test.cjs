const assert = require('node:assert/strict')
const { test } = require('node:test')
const { ContractFactory, constants, utils } = require('ethers')
const { compileV310, instantLedger } = require('../scripts/compile-v310.cjs')
const { treasuryRewardFunding } = require('../scripts/compile-v37.cjs')
const { rewardTransfer } = require('../scripts/compile-v38.cjs')
const { linkBytecode } = require('../scripts/link-bytecode.cjs')
const { startLocalAnvil } = require('../scripts/local-anvil.cjs')
const { reviewAndApprove, send } = require('../scripts/v36-fixture.cjs')

const DAY = 86_400

test('V3.10 starts in the creation block for direct Treasury, Treasury budget, and wallet funding', async (t) => {
  const fixtures = 'test/TreasuryFixturesV36.sol'
  const testNft = 'test/Fixtures.sol'
  const compiled = compileV310([fixtures, testNft])
  const local = await startLocalAnvil()
  t.after(local.close)
  const { provider } = local
  const [operator, participant] = await provider.listAccounts()
  const signer = provider.getSigner(operator)
  const participantSigner = provider.getSigner(participant)
  const links = {}
  const deploy = async (name, file, ...args) => {
    const artifact = compiled[file][name]
    const contract = await (await new ContractFactory(artifact.abi, linkBytecode(artifact, links), signer).deploy(...args)).deployed()
    links[`${file}:${name}`] = contract.address
    return contract
  }
  const wrapped = await deploy('WrappedFixtureV36', fixtures)
  const registry = await deploy('TreasuryAssetsV36', 'contracts/v36/TreasuryAssetsV36.sol', operator)
  const planner = await deploy('RewardRoutePlannerV36', 'contracts/v36/RewardRoutePlannerV36.sol', registry.address, wrapped.address)
  await deploy('ManagedRewardPositions', 'contracts/ManagedRewardPositions.sol')
  await deploy('TreasuryRewardFunding', treasuryRewardFunding)
  await deploy('RewardTransferV38', rewardTransfer)
  const ledger = await deploy('UniversalRewardsV310', instantLedger, planner.address)
  const vault = await deploy('TreasuryVaultV36', 'contracts/v36/TreasuryVaultV36.sol', ledger.address)
  const nft = await deploy('FixtureNft', testNft)
  assert.equal(await ledger.VERSION(), '3.10.0')
  assert.ok(utils.hexDataLength(await provider.getCode(ledger.address)) <= 24_576)
  await send(ledger.attachTreasuryVault(vault.address))
  await send(wrapped.deposit({ value: 1 }))
  await reviewAndApprove(registry, wrapped, provider, 18, 7)
  const budget = utils.parseEther('3')
  const deposit = budget.mul(2)
  await send(vault.deposit(wrapped.address, deposit, { value: deposit }))
  await send(nft.mint(participant, 1))
  const collections = [[137, nft.address, 3]]
  const rewards = [[wrapped.address, budget]]
  const funding = [wrapped.address, budget, 3600, [10000]]
  const noBudget = [constants.AddressZero, 0, 0, []]
  const config = (start = 0, end = DAY) => [start, end, 1, 20, 3, '']
  const refs = [[137, nft.address, 1]]
  const assertStarted = async (tx) => {
    const receipt = await send(tx)
    const block = await provider.getBlock(receipt.blockNumber)
    const { args } = receipt.events.find(({ event }) => event === 'PoolCreated')
    const { poolId, start, end } = args
    assert.equal(start.toNumber(), block.timestamp)
    assert.equal(end.toNumber(), block.timestamp + DAY)
    const state = await ledger.poolState(poolId, { blockTag: block.number })
    assert.ok(state.config.start.eq(start))
    assert.ok(state.config.end.eq(end))
    await ledger.connect(participantSigner).callStatic.joinBatch(poolId, refs, { blockTag: block.number })
    return poolId
  }

  await assert.rejects(ledger.callStatic.createPool(config(0, 0), collections, rewards))
  await assert.rejects(ledger.callStatic.createPool(config(0, DAY * 1460 + 1), collections, rewards))
  await assert.rejects(ledger.connect(participantSigner).callStatic.createPool(config(), collections, rewards))

  const direct = await assertStarted(ledger.createTreasuryFundedPool(config(), collections, rewards, noBudget, 0, false))
  assert.ok((await ledger.rewardState(direct, wrapped.address)).inventory.eq(budget))
  assert.equal((await ledger.treasuryFunding(direct)).treasuryBacked, true)

  const reserved = await assertStarted(ledger.createTreasuryFundedPool(config(), collections, rewards, funding, budget, true))
  assert.ok((await ledger.fundingState(reserved)).deposited.eq(budget))
  assert.equal((await ledger.treasuryFunding(reserved)).treasuryBacked, true)

  const wallet = await assertStarted(ledger.createFundedPool(config(), collections, rewards, funding))
  assert.ok((await ledger.fundingState(wallet)).deposited.isZero())
  await send(ledger.fundBudget(wallet, budget, { value: budget }))
  assert.ok((await ledger.fundingState(wallet)).deposited.eq(budget))

  const bare = await assertStarted(ledger.createPool(config(), collections, rewards))
  await assert.rejects(ledger.callStatic.configureFunding(bare, ...funding))
  const latest = await provider.getBlock('latest')
  const scheduled = latest.timestamp + 900
  const next = (await ledger.poolCount()).add(1)
  await send(ledger.createFundedPool(config(scheduled, scheduled + DAY), collections, rewards, funding))
  assert.equal((await ledger.poolState(next)).config.start.toNumber(), scheduled)
  await assert.rejects(ledger.connect(participantSigner).callStatic.joinBatch(next, refs))
})
