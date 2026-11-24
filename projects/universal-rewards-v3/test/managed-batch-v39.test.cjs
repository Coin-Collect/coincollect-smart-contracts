const assert = require('node:assert/strict')
const { test } = require('node:test')
const { ContractFactory, constants, utils } = require('ethers')
const { compileV39, managedBatchAdapter } = require('../scripts/compile-v39.cjs')
const { treasuryRewardFunding } = require('../scripts/compile-v37.cjs')
const { batchLedger, rewardTransfer } = require('../scripts/compile-v38.cjs')
const { linkBytecode } = require('../scripts/link-bytecode.cjs')
const { startLocalAnvil } = require('../scripts/local-anvil.cjs')
const { reviewAndApprove, send } = require('../scripts/v36-fixture.cjs')

test('V3.9 mixed pool exits direct NFTs and managed quantities atomically and pays released rewards', async (t) => {
  const fixtures = 'test/TreasuryFixturesV36.sol'
  const managedFixtures = 'test/ManagedFixtures.sol'
  const compiled = compileV39([fixtures, managedFixtures, 'test/Fixtures.sol'])
  const local = await startLocalAnvil()
  t.after(local.close)
  const { provider } = local
  const [operator, participant, other] = await provider.listAccounts()
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
  await deploy('RewardTransferV38', rewardTransfer)

  const ledger = await deploy('UniversalRewardsV38', batchLedger, planner.address)
  const collection = await deploy('Hooked1155Fixture', managedFixtures)
  const adapter = await deploy('ManagedNftCollectionV39', managedBatchAdapter, ledger.address, collection.address, 16)
  const direct = await deploy('FixtureNft', 'test/Fixtures.sol')
  assert.equal(await adapter.VERSION(), '3.9.0')
  assert.equal((await adapter.batchExitLimit()).toNumber(), 16)
  await send(collection.setHook(adapter.address))
  await send(ledger.approveManagedCollection(adapter.address))
  for (const id of [1, 2, 3]) await send(collection.mint(participant, id, 8))
  for (const id of [1, 2]) await send(direct.mint(participant, id))
  const vault = await deploy('TreasuryVaultV36', 'contracts/v36/TreasuryVaultV36.sol', ledger.address)
  await send(ledger.attachTreasuryVault(vault.address))
  await send(wrapped.deposit({ value: 1 }))
  await reviewAndApprove(registry, wrapped, provider, 18, 7)
  const funding = utils.parseEther('6')
  await send(vault.deposit(wrapped.address, funding, { value: funding }))
  const start = (await provider.getBlock('latest')).timestamp + 120
  await send(ledger.createTreasuryFundedPool(
    [start, start + 86_400, 1, 10, 8, ''],
    [[137, direct.address, 3], [137, adapter.address, 2]], [[wrapped.address, funding]],
    [constants.AddressZero, 0, 0, []], 0, false,
  ))
  const walletLedger = ledger.connect(provider.getSigner(participant))
  const walletAdapter = adapter.connect(provider.getSigner(participant))
  const directRefs = [1, 2].map((id) => [137, direct.address, id])
  await provider.send('evm_setNextBlockTimestamp', [start])
  await provider.send('evm_mine', [])
  await send(walletLedger.joinBatch(1, directRefs))
  for (const id of [1, 2, 3]) await send(walletAdapter.join(1, id, 4, { gasLimit: 1_500_000 }))
  await provider.send('evm_setNextBlockTimestamp', [start + 800])
  await provider.send('evm_mine', [])

  const directExit = await send(walletLedger.exitBatch(1, directRefs, { gasLimit: 1_500_000 }))
  assert.equal(directExit.events.filter(({ event }) => event === 'SeatChanged').length, 2)
  assert.equal(directExit.events.filter(({ event }) => event === 'Claimed').length, 2)
  assert.equal((await adapter.activeUnits(1)).toNumber(), 12)
  assert.equal(await direct.ownerOf(1), participant)

  const getPosition = async (id) => adapter.positions(await adapter.positionId(1, id, participant, false))
  await assert.rejects(async () => send(walletAdapter.exitBatch(1, [[1, 2], [2, 5]], { gasLimit: 2_500_000 })))
  assert.equal((await adapter.activeUnits(1)).toNumber(), 12)
  assert.equal((await getPosition(1)).entitled.toNumber(), 4)
  await assert.rejects(walletAdapter.callStatic.exitBatch(1, [[1, 1], [1, 1]]))
  await assert.rejects(adapter.connect(provider.getSigner(other)).callStatic.exitBatch(1, [[1, 1]]))
  const managedExit = await send(walletAdapter.exitBatch(1, [[1, 2], [2, 4]], { gasLimit: 2_500_000 }))
  const exits = managedExit.events.filter(({ event }) => event === 'UnitsChanged')
  assert.deepEqual(exits.map(({ args }) => [args.tokenId.toNumber(), args.active]), [[1, 2], [2, 0]])
  assert.equal((await adapter.activeUnits(1)).toNumber(), 6)
  assert.equal((await getPosition(3)).active, 4)
  assert.equal((await collection.balanceOf(participant, 2)).toNumber(), 8)
  const releasedRefs = await Promise.all([1, 2].map(async (id) =>
    [137, adapter.address, await adapter.positionId(1, id, participant, true)]))
  const before = await wrapped.balanceOf(participant)
  const harvest = await send(walletLedger.claimBatch(1, releasedRefs, { gasLimit: 2_500_000 }))
  const claims = harvest.events.filter(({ event }) => event === 'Claimed')
  assert.equal(claims.length, 2)
  assert.ok((await wrapped.balanceOf(participant)).sub(before)
    .eq(claims.reduce((total, { args }) => total.add(args.amount), constants.Zero)))
})
