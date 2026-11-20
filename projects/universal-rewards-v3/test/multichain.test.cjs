const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { constants, Contract, ContractFactory, utils, Wallet } = require('ethers')
const { compile } = require('../scripts/compile.cjs')
const { startLocalAnvil } = require('../scripts/local-anvil.cjs')
const { linkBytecode } = require('../scripts/link-bytecode.cjs')
const { collectFinalizedJournal, entryType, types } = require('../scripts/finalized-journal.cjs')

const ZERO = constants.AddressZero
const GAS = { gasLimit: 18_000_000 }
const DAY = 86400
const entryPoints = ['test/ManagedFixtures.sol', 'test/Fixtures.sol', 'contracts/NftSourceJournal.sol', 'contracts/FinalizedNftJournal.sol']
let build
const witnesses = Array.from({ length: 3 }, () => Wallet.createRandom()).sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()))

function makeChain(node, build) {
  const { provider } = node
  const signers = [0, 1, 2].map((index) => provider.getSigner(index))
  const latest = async () => (await provider.getBlock('latest')).timestamp
  const at = async (time) => {
    await provider.send('evm_setNextBlockTimestamp', [time])
    await provider.send('evm_mine', [])
  }
  const send = async (tx) => {
    const { hash } = await tx
    for (let i = 0; i < 200; i++) {
      const receipt = await provider.send('eth_getTransactionReceipt', [hash])
      if (receipt) {
        assert.equal(receipt.status, '0x1', hash)
        return Number(receipt.gasUsed)
      }
      await delay(50)
    }
    throw Error('Missing receipt for ' + hash)
  }
  const links = {}
  const deploy = async (name, ...args) => {
    const [file, artifact] = Object.entries(build).map(([path, entries]) => [path, entries[name]]).find(([, entry]) => entry)
    const contract = await new ContractFactory(artifact.abi, linkBytecode(artifact, links), signers[0]).deploy(...args)
    await send(contract.deployTransaction)
    links[file + ':' + name] = contract.address
    return contract
  }
  return { provider, signers, deploy, latest, at, send }
}

async function setup(t, withSecondary = false) {
  build ??= compile(entryPoints)
  const node = await startLocalAnvil()
  t.after(node.close)
  const chain = makeChain(node, build)
  const accounts = await chain.provider.listAccounts()
  await chain.deploy('ManagedRewardPositions')
  const reward = await chain.deploy('FixtureToken', 6)
  const secondary = withSecondary ? await chain.deploy('FixtureToken', 18) : undefined
  const assets = secondary ? [reward, secondary] : [reward]
  const ledger = await chain.deploy('UniversalRewardsV33', accounts[0], assets.map(({ address }) => address), ZERO, ZERO)
  const vault = await chain.deploy('TreasuryVault', ledger.address)
  await chain.send(ledger.attachTreasuryVault(vault.address))
  const verifier = await chain.deploy('FinalizedNftJournal', accounts[0], witnesses.map((wallet) => wallet.address), 2)
  return { build, chain, accounts, reward, secondary, assets, ledger, vault, verifier }
}

async function approvedAdapter(system, chainId, nft, standard, journal = ZERO) {
  const adapter = await system.chain.deploy('ManagedNftCollection', system.ledger.address,
    chainId, nft, standard, standard === 721 ? 1 : 100, journal)
  if (chainId === 137) {
    const collection = new Contract(nft, ['function setHook(address)'], system.chain.signers[0])
    await system.chain.send(collection.setHook(adapter.address))
  }
  await system.chain.send(system.ledger.approveManagedCollection(adapter.address))
  return adapter
}

async function seedPool(system, rules, limits = [0, 3000, 1200]) {
  const { chain, accounts, assets, ledger } = system
  const start = await chain.latest() + 30
  const end = start + 7200
  const amount = 720_000_000
  await chain.send(ledger.createPool([start, end, ...limits, ''], rules.map(([address, weight]) => [137, address, weight]),
    assets.map(({ address }, index) => [address, amount * (index + 1)])))
  for (const [index, asset] of assets.entries()) {
    const inventory = amount * (index + 1)
    await chain.send(asset.mint(accounts[0], inventory))
    await chain.send(asset.approve(ledger.address, inventory))
    await chain.send(ledger.fundReward(1, asset.address, inventory))
  }
  await chain.at(start)
  return { start, end, amount }
}

const sign = (evidence) => Promise.all(witnesses.slice(0, 2).map((signer) =>
  signer._signTypedData(evidence.domain, evidence.types, evidence.value)))

async function keyFor(ledger, adapter, token, owner, released = false) {
  const id = await adapter.positionId(1, token, owner, released)
  return { id, key: await ledger.nftKey(137, adapter.address, id) }
}

test('Polygon ERC-1155 transfers, burns and partial exits conserve rights independently of ERC-721', { timeout: 150_000 }, async (t) => {
  const system = await setup(t, true)
  const { chain, accounts: [admin, alice, bob, outsider], ledger, reward, secondary } = system
  const [ , owner, recipient ] = chain.signers
  const local = await chain.deploy('Hooked1155Fixture')
  const nft = await chain.deploy('FixtureNft')
  const adapter = await approvedAdapter(system, 137, local.address, 1155)
  const { start, end, amount } = await seedPool(system, [[adapter.address, 2], [nft.address, 3]], [2, 10, 2])
  await chain.send(local.mint(alice, 25, 10))
  await chain.send(local.mint(bob, 25, 2))
  await chain.send(nft.mint(bob, 25))
  const a = await keyFor(ledger, adapter, 25, alice)
  const b = await keyFor(ledger, adapter, 25, bob)
  await assert.rejects(ledger.connect(owner).callStatic.join(1, 137, adapter.address, a.id))
  await assert.rejects(adapter.connect(owner).callStatic.join(1, 25, 11))
  await chain.send(adapter.connect(owner).join(1, 25, 6, GAS))
  await chain.send(ledger.connect(recipient).join(1, 137, nft.address, 25, GAS))
  assert.equal(await local.isApprovedForAll(alice, ledger.address), false)
  await chain.at(start + 100)
  const before = await ledger.claimable(1, a.key, reward.address)
  await chain.send(local.connect(owner).safeBatchTransferFrom(alice, bob, [25, 25], [1, 1], '0x', GAS))
  const aCredit = await ledger.claimable(1, a.key, reward.address)
  const bCredit = await ledger.claimable(1, b.key, reward.address)
  assert.ok(aCredit.add(bCredit).gte(before.sub(1)))
  assert.ok(bCredit.gte(before.div(3).sub(1)))
  assert.equal((await adapter.positions(a.id)).active, 4)
  assert.equal((await adapter.positions(b.id)).active, 2)
  assert.equal((await ledger.poolState(1)).activeWallets, 2)
  assert.equal((await adapter.activeUnits(1)).toNumber(), 6)
  await chain.send(local.connect(recipient).burn(25, 1, GAS))
  await chain.send(adapter.connect(owner).exit(1, 25, 2, GAS))
  const released = await keyFor(ledger, adapter, 25, alice, true)
  assert.ok((await ledger.claimable(1, released.key, reward.address)).gt(0))
  await chain.send(local.connect(owner).safeTransferFrom(alice, bob, 25, 8, '0x', GAS))
  assert.equal((await adapter.positions(a.id)).entitled.toNumber(), 0)
  assert.equal((await adapter.positions(b.id)).active, 3)
  // Bob is already at the position cap with one ERC-721 and ERC-1155 #25.
  await chain.send(local.mint(alice, 26, 3))
  await chain.send(adapter.connect(owner).join(1, 26, 3, GAS))
  await chain.at(start + 200)
  await chain.send(local.connect(owner).safeTransferFrom(alice, bob, 26, 3, '0x', GAS))
  const capped = await keyFor(ledger, adapter, 26, bob)
  assert.equal((await adapter.positions(capped.id)).active, 0)
  assert.equal((await adapter.positions(capped.id)).entitled.toNumber(), 3)
  assert.ok((await ledger.claimable(1, capped.key, reward.address)).gt(0))
  await assert.rejects(adapter.connect(recipient).callStatic.join(1, 26, 1))
  await chain.at(end)
  await chain.send(ledger.connect(owner).claim(1, 137, adapter.address, released.id, GAS))
  await chain.send(ledger.connect(recipient).claim(1, 137, adapter.address, b.id, GAS))
  await chain.send(ledger.connect(recipient).claim(1, 137, nft.address, 25, GAS))
  await chain.send(ledger.connect(recipient).claim(1, 137, adapter.address, capped.id, GAS))
  await chain.at(end + 30 * DAY)
  await assert.rejects(ledger.connect(recipient).callStatic.claim(1, 137, adapter.address, b.id))
  await chain.send(ledger.connect(chain.provider.getSigner(outsider)).recoverExpiredRewards(1, reward.address, GAS))
  const distributed = await reward.balanceOf(alice)
  assert.equal(distributed.add(await reward.balanceOf(bob)).add(await reward.balanceOf(admin)).toNumber(), amount)
  await chain.send(ledger.recoverExpiredRewards(1, secondary.address, GAS))
  const secondPayout = (await secondary.balanceOf(alice)).add(await secondary.balanceOf(bob))
  assert.ok(secondPayout.gt(0))
  assert.equal(secondPayout.add(await secondary.balanceOf(admin)).toNumber(), 2 * amount)
})

async function relayBatch(system, adapter, sourceJournal, chainId, first, entries, timestamp, blockNumber = 1, sourceSequence = first + entries.length - 1) {
  const value = {
    adapter: adapter.address, sourceJournal, chain: chainId, collection: await adapter.sourceCollection(), first,
    sourceBlock: blockNumber, sourceHash: utils.hexZeroPad(utils.hexlify(blockNumber), 32), finalizedAt: timestamp, sourceSequence,
    entriesHash: utils.keccak256(utils.defaultAbiCoder.encode([entryType], [entries])),
  }
  const domain = { name: 'CoinCollect NFT Journal', version: '3.4', chainId: 31337, verifyingContract: system.verifier.address }
  const batch = { first, sourceBlock: blockNumber, sourceHash: value.sourceHash, finalizedAt: timestamp, sourceSequence }
  return system.chain.send(system.verifier.applyBatch(adapter.address, batch, entries, await sign({ domain, types, value }), GAS))
}

test('one ledger consumes finalized transfer and intent journals on independent Base and Arbitrum fixtures', { timeout: 150_000 }, async (t) => {
  const system = await setup(t)
  const { accounts: [, alice, bob], chain, ledger, reward, verifier } = system
  const nodes = await Promise.all([8453, 42161].map((id) => startLocalAnvil([], id)))
  t.after(() => nodes.forEach((node) => node.close()))
  const streams = []
  for (const [index, node] of nodes.entries()) {
    const source = makeChain(node, system.build)
    const chainId = [8453, 42161][index]
    for (const standard of [721, 1155]) {
      const nft = await source.deploy(standard === 721 ? 'Hooked721Fixture' : 'Hooked1155Fixture')
      const journal = await source.deploy('NftSourceJournal', nft.address, ledger.address, standard)
      await source.send(nft.setHook(journal.address))
      const adapter = await approvedAdapter(system, chainId, nft.address, standard, verifier.address)
      await chain.send(verifier.register(adapter.address, journal.address))
      streams.push({ node, source, chainId, standard, nft, journal, adapter, cursor: 1 })
    }
  }
  const local = await chain.deploy('FixtureNft')
  const local1155 = await chain.deploy('Hooked1155Fixture')
  const localAdapter = await approvedAdapter(system, 137, local1155.address, 1155)
  const { start, amount } = await seedPool(system, [
    [local.address, 1], [localAdapter.address, 2], ...streams.map(({ adapter }, index) => [adapter.address, index + 1]),
  ], [2, 32, 32])
  await chain.send(local.mint(alice, 25))
  await chain.send(local1155.mint(alice, 25, 10))
  await chain.send(ledger.connect(chain.signers[1]).join(1, 137, local.address, 25, GAS))
  await chain.send(localAdapter.connect(chain.signers[1]).join(1, 25, 6, GAS))
  for (const stream of streams) {
    const { source, nft, journal, standard } = stream
    if (await source.latest() < start) await source.at(start)
    if (standard === 721) await source.send(nft.mint(alice, 25))
    else {
      await source.send(nft.mint(alice, 25, 10))
      if (stream.chainId === 42161) {
        const large = constants.MaxUint256.sub(1)
        await source.send(nft.mint(alice, 90, large))
        await source.send(nft.connect(source.signers[1]).safeTransferFrom(alice, bob, 90, large, '0x'))
        assert.ok((await nft.balanceOf(bob, 90)).eq(large))
      }
    }
    const sourceJoin = await source.send(journal.connect(source.signers[1]).request(1, 1, 25, standard === 721 ? 1 : 6))
    t.diagnostic(JSON.stringify({ chain: stream.chainId, standard, sourceJoin }))
  }
  await Promise.all(nodes.map(({ provider }) => provider.send('anvil_mine', ['0x50'])))
  const apply = async (stream, verifyRejects = false, limit = 32) => {
    const { node, source, nft, journal, adapter, chainId, standard } = stream
    // Both independently queried clients point to the same deterministic fixture chain in this test.
    const clients = ['fixture-a', 'fixture-b'].map((id) => ({ id, request: node.provider.send.bind(node.provider) }))
    const code = async (address) => utils.keccak256(await source.provider.getCode(address))
    const previous = await verifier.streams(adapter.address)
    const policy = {
      chain: chainId, sourceJournal: journal.address, collection: nft.address, standard, settlementLedger: ledger.address,
      sourceRuntimeHash: await code(journal.address), collectionRuntimeHash: await code(nft.address),
      adapter: adapter.address, verifier: verifier.address, first: stream.cursor, fromBlock: 1,
      now: await chain.latest(), clients,
      previous: previous.sourceBlock.isZero() ? undefined : previous,
    }
    const evidence = await collectFinalizedJournal(policy)
    assert.ok(evidence, 'expected finalized entries or a new heartbeat')
    if (evidence.entries.length > limit) {
      evidence.entries = evidence.entries.slice(0, limit)
      evidence.value.entriesHash = utils.keccak256(utils.defaultAbiCoder.encode([entryType], [evidence.entries]))
    }
    const signatures = await sign(evidence)
    if (verifyRejects) {
      const foreign = await witnesses[0]._signTypedData({ ...evidence.domain, chainId: 137 }, evidence.types, evidence.value)
      await assert.rejects(verifier.callStatic.applyBatch(adapter.address, evidence.batch, evidence.entries, [foreign, signatures[1]], GAS))
      await assert.rejects(verifier.callStatic.applyBatch(adapter.address, { ...evidence.batch, first: stream.cursor + 1 }, evidence.entries, signatures, GAS))
      await assert.rejects(verifier.callStatic.applyBatch(adapter.address, evidence.batch, evidence.entries, [signatures[0], signatures[0]], GAS))
      await assert.rejects(verifier.callStatic.applyBatch(adapter.address, evidence.batch, evidence.entries, signatures, { gasLimit: 1_100_000 }))
      assert.equal((await verifier.streams(adapter.address)).next.toNumber(), stream.cursor)
      await assert.rejects(collectFinalizedJournal({ ...policy, now: policy.now + 7201 }))
      await assert.rejects(collectFinalizedJournal({ ...policy, previous: { sourceBlock: evidence.batch.sourceBlock, sourceHash: constants.HashZero } }))
      await assert.rejects(collectFinalizedJournal({ ...policy, clients: [clients[0], { id: 'outage', request: async () => { throw Error('unavailable') } }] }))
      const truncated = { id: 'truncated', request: async (method, params) => {
        const result = await node.provider.send(method, params)
        return method === 'eth_getLogs' ? result.slice(0, -1) : result
      } }
      await assert.rejects(collectFinalizedJournal({ ...policy, clients: [clients[0], truncated] }), /omitted journal entries/)
    }
    const relayGas = await chain.send(verifier.applyBatch(adapter.address, evidence.batch, evidence.entries, signatures, GAS))
    await assert.rejects(verifier.callStatic.applyBatch(adapter.address, evidence.batch, evidence.entries, signatures, GAS))
    stream.cursor += evidence.entries.length
    t.diagnostic(JSON.stringify({ chain: chainId, standard, relayEntries: evidence.entries.length, relayGas }))
    return evidence
  }

  await chain.at(start + 200)
  for (const stream of streams) await apply(stream, stream === streams[0])
  assert.equal((await ledger.poolState(1)).activeNfts.toNumber(), 6)
  assert.equal((await ledger.poolState(1)).activeWallets, 1)
  await chain.at(start + 500)
  const [beforeDelay] = await ledger.rewardSettlement(1, reward.address)
  const observedPower = (await ledger.poolState(1)).totalWeight.toNumber()
  for (const stream of streams) {
    const { source, nft, journal, standard, adapter } = stream
    const a = await keyFor(ledger, adapter, 25, alice)
    await assert.rejects(ledger.connect(chain.signers[1]).callStatic.claim(1, 137, adapter.address, a.id))
    if (await source.latest() < start + 500) await source.at(start + 500)
    const sourceTransfer = standard === 721 ? await source.send(nft.connect(source.signers[1]).transferFrom(alice, bob, 25))
      : await source.send(nft.connect(source.signers[1]).safeTransferFrom(alice, bob, 25, 2, '0x'))
    t.diagnostic(JSON.stringify({ chain: stream.chainId, standard, sourceTransfer }))
    if (standard === 721) await assert.rejects(journal.connect(source.signers[1]).callStatic.request(3, 1, 25, 0))
    const sourceRelease = await source.send(journal.connect(source.signers[2]).request(3, 1, 25, 0))
    if (stream === streams[0]) await source.send(journal.connect(source.signers[2]).request(3, 1, 25, 0))
    t.diagnostic(JSON.stringify({ chain: stream.chainId, standard, sourceRelease }))
  }
  await Promise.all(nodes.map(({ provider }) => provider.send('anvil_mine', ['0x50'])))
  await chain.at(start + 1100)
  assert.equal((await ledger.poolState(1)).activeWallets, 1)
  const [afterDelay] = await ledger.rewardSettlement(1, reward.address)
  const precision = constants.WeiPerEther
  const observedEmissions = afterDelay.sub(beforeDelay).div(precision).toNumber()
  const timelyEmissions = amount / 7200 * 600
  assert.ok(timelyEmissions / 2 - observedEmissions <= 1 && observedEmissions <= timelyEmissions / 2)
  t.diagnostic(JSON.stringify({ delaySeconds: 600, threshold: 2, observedWallets: 1, observedPower, observedEmissions, timelyEmissions }))
  for (const stream of streams) {
    const earned = await keyFor(ledger, stream.adapter, 25, bob, true)
    if (stream === streams[0]) {
      const first = await apply(stream, false, 1)
      assert.equal(await verifier.allowsClaims(stream.adapter.address), false)
      const conflictingBatch = { ...first.batch, first: stream.cursor, sourceSequence: stream.cursor - 1 }
      const conflict = {
        ...first, value: {
          ...first.value, ...conflictingBatch,
          entriesHash: utils.keccak256(utils.defaultAbiCoder.encode([entryType], [[]])),
        },
      }
      await assert.rejects(verifier.callStatic.applyBatch(
        stream.adapter.address, conflictingBatch, [], await sign(conflict), GAS,
      ))
      await apply(stream, false, 1)
      const credited = await ledger.claimable(1, earned.key, reward.address)
      assert.ok(credited.gt(0))
      assert.equal(await verifier.allowsClaims(stream.adapter.address), false)
      const atFirstRelease = await chain.latest()
      await apply(stream)
      const repeated = await ledger.claimable(1, earned.key, reward.address)
      const elapsed = (await chain.latest()) - atFirstRelease
      assert.ok(repeated.sub(credited).lte(elapsed * 100_000 + 1))
    } else await apply(stream)
    assert.ok((await ledger.claimable(1, earned.key, reward.address)).gt(0))
    if (stream === streams[0]) {
      await chain.send(verifier.setPaused(stream.adapter.address, true))
      await assert.rejects(ledger.connect(chain.signers[2]).callStatic.claim(1, 137, stream.adapter.address, earned.id))
      await chain.send(verifier.setPaused(stream.adapter.address, false))
    }
    const before = await reward.balanceOf(bob)
    const claimGas = await chain.send(ledger.connect(chain.signers[2]).claim(1, 137, stream.adapter.address, earned.id, GAS))
    t.diagnostic(JSON.stringify({ chain: stream.chainId, standard: stream.standard, claimGas }))
    const paid = await reward.balanceOf(bob)
    assert.ok(paid.gt(before))
    await chain.send(ledger.connect(chain.signers[2]).claim(1, 137, stream.adapter.address, earned.id, GAS))
    assert.ok((await reward.balanceOf(bob)).eq(paid))
  }
  assert.equal((await ledger.poolState(1)).activeWallets, 2)
  assert.equal((await ledger.walletPositionStats(1, alice)).power.toNumber(), 37)
  assert.equal((await ledger.walletPositionStats(1, bob)).power.toNumber(), 16)
  const stream = streams[0]
  const old = await verifier.streams(stream.adapter.address)
  const earned = await keyFor(ledger, stream.adapter, 25, bob, true)
  const delayUntil = old.finalizedAt.toNumber() + 7200
  await chain.at(delayUntil)
  assert.equal(await verifier.allowsClaims(stream.adapter.address), false)
  await assert.rejects(ledger.connect(chain.signers[2]).callStatic.claim(1, 137, stream.adapter.address, earned.id))
  await stream.source.at(delayUntil)
  await stream.node.provider.send('anvil_mine', ['0x50'])
  await chain.at(delayUntil + 200)
  const heartbeat = await apply(stream)
  assert.equal(heartbeat.entries.length, 0)
  assert.equal((await verifier.streams(stream.adapter.address)).next.toNumber(), stream.cursor)
  assert.equal(await verifier.allowsClaims(stream.adapter.address), true)
})

test('mixed position checkpoints stay bounded at 32, 128, 512 and 1,024 across 1,024 distinct wallets', { timeout: 150_000 }, async (t) => {
  const system = await setup(t)
  const { chain, accounts: [admin], ledger, reward, verifier } = system
  const collections = []
  for (const [chainId, standard] of [[8453, 721], [8453, 1155], [42161, 721], [42161, 1155]]) {
    const sourceCollection = utils.getAddress(utils.hexZeroPad(utils.hexlify(chainId * 10000 + standard), 20))
    const syntheticJournal = utils.getAddress(utils.hexZeroPad(utils.hexlify(chainId * 10000 + standard + 1), 20))
    const adapter = await approvedAdapter(system, chainId, sourceCollection, standard, verifier.address)
    await chain.send(verifier.register(adapter.address, syntheticJournal))
    collections.push({ chainId, standard, adapter, syntheticJournal, first: 1, block: 1, participants: [] })
  }
  const { start, end } = await seedPool(system, collections.map(({ standard, adapter }) => [adapter.address, standard === 721 ? 1 : 2]))
  let inserted = 0
  const costs = []
  const owner = (id) => utils.getAddress(utils.hexZeroPad(utils.hexlify(10000 + id), 20))
  for (const target of [32, 128, 512, 1024]) {
    let lastJoin
    while (inserted < target) {
      for (const stream of collections) {
        const entries = Array.from({ length: Math.min(8, (target - inserted) / (4 - collections.indexOf(stream))) }, (_, offset) => [
          1, 1, stream.first + offset, owner(inserted + offset), ZERO, stream.standard === 721 ? 1 : 3, 10, start,
        ])
        if (entries.length === 0) continue
        lastJoin = await relayBatch(system, stream.adapter, stream.syntheticJournal, stream.chainId, stream.first,
          entries, start, stream.block++)
        stream.participants.push(...entries.map((entry) => ({ tokenId: entry[2], account: entry[3], units: entry[5] })))
        stream.first += entries.length
        inserted += entries.length
      }
    }
    await chain.at(start + target + 1)
    await chain.send(ledger.checkpoint(1, GAS))
    await chain.at(start + target + 12)
    const checkpoint = await chain.send(ledger.checkpoint(1, GAS))
    const state = await ledger.poolState(1)
    assert.equal(state.activeNfts.toNumber(), target)
    assert.equal(state.activeWallets, target)
    assert.equal(state.totalWeight.toNumber(), target * 3.5)
    assert.ok(checkpoint < 130_000)
    costs.push(checkpoint)
    const snapshot = await chain.provider.send('evm_snapshot', [])
    const probe = collections[0]
    const to = chain.signers[2]
    const successor = await to.getAddress()
    const observedAt = await chain.latest()
    const transfer = await relayBatch(system, probe.adapter, probe.syntheticJournal, probe.chainId, probe.first,
      [[0, 0, 1, owner(0), successor, 1, 0, observedAt]], observedAt, probe.block)
    const exit = await relayBatch(system, probe.adapter, probe.syntheticJournal, probe.chainId, probe.first + 1,
      [[2, 1, 1, successor, ZERO, 1, 1, observedAt]], observedAt, probe.block + 1)
    const released = await keyFor(ledger, probe.adapter, 1, successor, true)
    const claim = await chain.send(ledger.connect(to).claim(1, 137, probe.adapter.address, released.id, GAS))
    await chain.at(end + 30 * DAY)
    const settle = await chain.send(ledger.recoverExpiredRewards(1, reward.address, GAS))
    assert.ok(await chain.provider.send('evm_revert', [snapshot]))
    t.diagnostic(JSON.stringify({ positions: target, wallets: target, checkpoint, eightJournalJoins: lastJoin, transfer, exit, claim, settle }))
  }
  assert.ok(Math.max(...costs) - Math.min(...costs) < 10_000)
  const delayedAt = start + 1_100
  await chain.at(start + 1_800)
  let moved = 0
  for (let wave = 1; wave <= 2; wave++) {
    for (const stream of collections) {
      for (let offset = 0; offset < stream.participants.length; offset += 32) {
        const entries = stream.participants.slice(offset, offset + 32).map((position) => {
          const recipient = owner(2000 + moved++)
          const entry = [0, 0, position.tokenId, position.account, recipient, position.units, 0, delayedAt + wave]
          position.account = recipient
          return entry
        })
        await relayBatch(system, stream.adapter, stream.syntheticJournal, stream.chainId, stream.first,
          entries, await chain.latest(), stream.block++)
        stream.first += entries.length
      }
    }
  }
  assert.equal(moved, 2048)
  assert.equal((await ledger.poolState(1)).activeWallets, 1024)
  assert.equal((await ledger.poolState(1)).totalWeight.toNumber(), 3584)
  t.diagnostic('2,048 delayed transfers in batches of 32 maintained 1,024 distinct active wallet seats')
  await chain.at(end + 30 * DAY)
  await chain.send(ledger.recoverExpiredRewards(1, reward.address, GAS))
  assert.ok((await reward.balanceOf(admin)).gt(0))
})

test('a live Polygon chain ID cannot instantiate the isolated verifier or a remote adapter', { timeout: 150_000 }, async (t) => {
  build ??= compile(entryPoints)
  const node = await startLocalAnvil([], 137)
  t.after(node.close)
  const chain = makeChain(node, build)
  const [owner] = await chain.provider.listAccounts()
  await assert.rejects(chain.deploy('FinalizedNftJournal', owner, witnesses.map(({ address }) => address), 2))
  const reward = await chain.deploy('FixtureToken', 6)
  await chain.deploy('ManagedRewardPositions')
  const ledger = await chain.deploy('UniversalRewardsV33', owner, [reward.address], ZERO, ZERO)
  await assert.rejects(chain.deploy('ManagedNftCollection', ledger.address, 8453, owner, 721, 1, reward.address))
  await assert.rejects(chain.deploy('ManagedNftCollection', ledger.address, 42161, owner, 1155, 10, reward.address))
})


test('transfer hooks fail atomically on ledger errors and match actual receiver forwarding', { timeout: 150_000 }, async (t) => {
  const system = await setup(t, true)
  const { chain, accounts: [, alice, bob], ledger, vault, reward } = system
  const [, owner] = chain.signers
  const plain = await chain.deploy('Plain1155Fixture')
  const nft721 = await chain.deploy('FixtureNft')
  const broken = await chain.deploy('FailingManagedLedgerFixture')
  await assert.rejects(chain.deploy('ManagedNftCollection', ledger.address, 137, nft721.address, 1155, 100, ZERO))
  const unbound = await chain.deploy('ManagedNftCollection', ledger.address, 137, plain.address, 1155, 100, ZERO)
  await assert.rejects(ledger.callStatic.approveManagedCollection(unbound.address))
  assert.equal(await unbound.hasLocalHook(), false)
  await assert.rejects(unbound.connect(owner).callStatic.join(1, 1, 1))

  const affected = await chain.deploy('Hooked1155Fixture')
  const failureHook = await chain.deploy('ManagedNftCollection', broken.address, 137, affected.address, 1155, 100, ZERO)
  await chain.send(affected.setHook(failureHook.address))
  await chain.send(affected.mint(alice, 1, 6))
  await chain.send(failureHook.connect(owner).join(1, 1, 6, GAS))
  await chain.send(broken.setFailure(true))
  await assert.rejects(chain.send(affected.connect(owner).safeTransferFrom(alice, bob, 1, 2, '0x', GAS)))
  assert.equal((await affected.balanceOf(alice, 1)).toNumber(), 6)
  assert.equal((await failureHook.positions(await failureHook.positionId(1, 1, alice, false))).entitled.toNumber(), 6)
  await chain.send(broken.setFailure(false))
  await chain.send(affected.connect(owner).safeTransferFrom(alice, bob, 1, 2, '0x', GAS))
  assert.equal((await affected.balanceOf(bob, 1)).toNumber(), 2)

  const nft = await chain.deploy('Hooked1155Fixture')
  const adapter = await approvedAdapter(system, 137, nft.address, 1155)
  assert.equal(await adapter.hasLocalHook(), true)
  const { start, end } = await seedPool(system, [[adapter.address, 3], [nft721.address, 1]])
  await chain.send(nft.mint(alice, 1, 10))
  const localJoin = await chain.send(adapter.connect(owner).join(1, 1, 6, GAS))
  await chain.send(vault.setPaused(true))
  await chain.at(start + 100)
  const receiver = await chain.deploy('Forwarding1155Receiver', bob, adapter.address)
  await assert.rejects(chain.send(nft.connect(owner).safeTransferFrom(alice, bob, 1, 2, '0x', { gasLimit: 80_000 })))
  assert.equal((await nft.balanceOf(alice, 1)).toNumber(), 10)
  await assert.rejects(chain.send(nft.connect(owner).safeTransferFrom(alice, ledger.address, 1, 2, '0x', GAS)))
  const gas = await chain.send(nft.connect(owner).safeTransferFrom(alice, receiver.address, 1, 2, '0x', GAS))
  assert.equal(await receiver.forgedHookRejected(), true)
  assert.equal((await nft.balanceOf(receiver.address, 1)).toNumber(), 0)
  const b = await keyFor(ledger, adapter, 1, bob)
  assert.equal((await adapter.positions(b.id)).entitled.toNumber(), 2)
  assert.ok((await ledger.claimable(1, b.key, reward.address)).gt(0))
  const midpoint = await chain.latest()
  await chain.at(end)
  await assert.rejects(adapter.connect(owner).callStatic.join(1, 1, 1))
  await chain.at(end + 30 * DAY - 2)
  await chain.send(nft.connect(owner).safeTransferFrom(alice, bob, 1, 1, '0x', GAS))
  assert.equal((await adapter.positions(b.id)).entitled.toNumber(), 3)
  assert.ok((await ledger.claimable(1, b.key, reward.address)).gt(0))
  await chain.at(end + 30 * DAY)
  const expired = await chain.send(nft.connect(owner).safeTransferFrom(alice, bob, 1, 1, '0x', GAS))
  assert.equal((await nft.balanceOf(bob, 1)).toNumber(), 4)
  assert.equal((await ledger.claimable(1, b.key, reward.address)).toNumber(), 0)
  t.diagnostic(JSON.stringify({ localJoinTwoRewards: localJoin, forwardThroughReceiver: gas, expiredSingleTransfer: expired, midpoint }))
})

test('eight live pools keep ordinary and mixed batch transfers bounded', { timeout: 150_000 }, async (t) => {
  const system = await setup(t)
  const { chain, ledger, reward, accounts: [, alice, bob] } = system
  const [, owner] = chain.signers
  const nft = await chain.deploy('Hooked1155Fixture')
  const adapter = await approvedAdapter(system, 137, nft.address, 1155)
  const start = await chain.latest() + 300
  const end = start + 1800
  for (let i = 0; i < 9; i++) {
    const delta = i === 8 ? 40 * DAY : 0
    await chain.send(ledger.createPool([start, end + delta, 0, 32, 32, ''], [[137, adapter.address, 2]], [[reward.address, 100_000]]))
  }
  for (let id = 1; id <= 64; id++) await chain.send(nft.mint(alice, id, 4))
  await chain.at(start)
  for (let pool = 1; pool <= 8; pool++) {
    for (const id of [1, 2]) await chain.send(adapter.connect(owner).join(pool, id, 2, GAS))
  }
  await assert.rejects(adapter.connect(owner).callStatic.join(9, 1, 2))
  const withEight = await chain.send(nft.connect(owner).safeTransferFrom(alice, bob, 1, 1, '0x', GAS))
  const ids = Array.from({ length: 64 }, (_, index) => index + 1)
  const batch = await chain.send(nft.connect(owner).safeBatchTransferFrom(alice, bob, ids, ids.map(() => 1), '0x', GAS))
  assert.equal((await nft.balanceOf(bob, 64)).toNumber(), 1)
  assert.equal((await adapter.positions(await adapter.positionId(8, 2, bob, false))).entitled.toNumber(), 1)
  assert.ok(batch < 10_000_000)
  await chain.at(end + 30 * DAY)
  await chain.send(adapter.connect(owner).join(9, 2, 1, GAS))
  assert.deepEqual((await adapter.trackPools()).map(Number), [9])
  t.diagnostic(JSON.stringify({ oneIdEightPools: withEight, batch64WithTwoEnrolledInEightPools: batch }))
})

test('seeded ERC-1155 movements conserve scaled credit and race safely with treasury recovery', { timeout: 150_000 }, async (t) => {
  const system = await setup(t, true)
  const { chain, ledger, assets, accounts: [admin, alice, bob, carol] } = system
  const nft = await chain.deploy('Hooked1155Fixture')
  const adapter = await approvedAdapter(system, 137, nft.address, 1155)
  const { end, amount } = await seedPool(system, [[adapter.address, 2]])
  const accounts = [alice, bob, carol]
  const owned = [100n, 30n, 20n]
  const entitled = [60n, 0n, 0n]
  for (let i = 0; i < accounts.length; i++) await chain.send(nft.mint(accounts[i], 31, owned[i]))
  await chain.send(adapter.connect(chain.signers[1]).join(1, 31, 60, GAS))
  await chain.at(end)
  await chain.send(ledger.checkpoint(1, GAS))
  const outstanding = await Promise.all(assets.map(({ address }) => ledger.rewardSettlement(1, address)))
  const credits = outstanding.map(([scaled]) => [BigInt(scaled.toString()), 0n, 0n])
  const released = assets.map(() => [0n, 0n, 0n])
  const references = await Promise.all(accounts.map((account) => keyFor(ledger, adapter, 31, account)))
  const exits = await Promise.all(accounts.map((account) => keyFor(ledger, adapter, 31, account, true)))
  const precision = 10n ** 18n
  let rng = 0x321034
  let exitCount = 0
  const sample = () => {
    rng ^= rng << 13
    rng ^= rng >>> 17
    rng ^= rng << 5
    return rng >>> 0
  }
  const reconcile = async () => {
    for (let i = 0; i < accounts.length; i++) {
      const position = await adapter.positions(references[i].id)
      assert.equal(BigInt(position.entitled.toString()), entitled[i])
      assert.equal(BigInt((await nft.balanceOf(accounts[i], 31)).toString()), owned[i])
      for (let j = 0; j < assets.length; j++) {
        assert.equal(BigInt((await ledger.claimable(1, references[i].key, assets[j].address)).toString()), credits[j][i] / precision)
        assert.equal(BigInt((await ledger.claimable(1, exits[i].key, assets[j].address)).toString()), released[j][i] / precision)
      }
    }
    for (let j = 0; j < assets.length; j++) {
      const [actual] = await ledger.rewardSettlement(1, assets[j].address)
      assert.equal(actual.toString(), outstanding[j][0].toString())
      assert.equal(credits[j].reduce((sum, value) => sum + value, 0n) + released[j].reduce((sum, value) => sum + value, 0n),
        BigInt(actual.toString()))
    }
  }
  for (let step = 0; step < 96; step++) {
    const from = sample() % 3
    const to = (from + 1 + sample() % 2) % 3
    if (owned[from] === 0n) continue
    const owner = chain.provider.getSigner(accounts[from])
    const partialExit = step % 11 === 0 && entitled[from] > 0n
    const total = partialExit ? entitled[from] : owned[from]
    const quantity = 1n + BigInt(sample()) % (total < 8n ? total : 8n)
    const moved = quantity < entitled[from] ? quantity : entitled[from]
    for (let j = 0; j < assets.length; j++) {
      const share = moved === 0n ? 0n : credits[j][from] * moved / entitled[from]
      credits[j][from] -= share
      if (partialExit) released[j][from] += share
      else credits[j][to] += share
    }
    entitled[from] -= moved
    if (partialExit) {
      await chain.send(adapter.connect(owner).exit(1, 31, quantity, GAS))
      ++exitCount
    } else {
      owned[from] -= quantity
      owned[to] += quantity
      entitled[to] += moved
      await chain.send(nft.connect(owner).safeTransferFrom(accounts[from], accounts[to], 31, quantity, '0x', GAS))
    }
    if (step % 12 === 0) await reconcile()
  }
  await reconcile()
  assert.ok(exitCount > 1)

  // Same-block claim and permissionless recovery at exactly the deadline.
  const deadline = end + 30 * DAY
  await chain.provider.send('evm_setAutomine', [false])
  try {
    const submit = (from, functionName, args) => chain.provider.send('eth_sendTransaction', [{
      from, to: ledger.address, data: ledger.interface.encodeFunctionData(functionName, args), gas: '0x989680',
    }])
    const claim = await submit(alice, 'claim', [1, 137, adapter.address, exits[0].id])
    const recovery = await submit(bob, 'recoverExpiredRewards', [1, assets[0].address])
    await chain.provider.send('evm_setNextBlockTimestamp', [deadline])
    await chain.provider.send('evm_mine', [])
    const receipts = await Promise.all([claim, recovery].map((hash) => chain.provider.send('eth_getTransactionReceipt', [hash])))
    assert.equal(receipts[0].blockNumber, receipts[1].blockNumber)
    assert.deepEqual(receipts.map(({ status }) => status), ['0x0', '0x1'])
    assert.equal((await assets[0].balanceOf(admin)).toNumber(), amount)
    assert.equal((await assets[0].balanceOf(alice)).toNumber(), 0)
  } finally {
    await chain.provider.send('evm_setAutomine', [true])
  }
})


test('unexpected remote intent failures keep the verified cursor retryable', { timeout: 150_000 }, async (t) => {
  const system = await setup(t)
  const { chain, verifier, accounts: [admin, alice, , sourceJournal] } = system
  const broken = await chain.deploy('FailingManagedLedgerFixture')
  const adapter = await chain.deploy('ManagedNftCollection', broken.address, 8453, admin, 1155, 100, verifier.address)
  await chain.send(verifier.register(adapter.address, sourceJournal))
  const now = await chain.latest()
  const entry = [[1, 1, 25, alice, ZERO, 1, 1, now]]
  await chain.send(broken.setFailure(true))
  await assert.rejects(relayBatch(system, adapter, sourceJournal, 8453, 1, entry, now))
  assert.equal((await verifier.streams(adapter.address)).next.toNumber(), 1)
  await chain.send(broken.setFailure(false))
  await chain.send(broken.setExhaustion(true))
  await assert.rejects(relayBatch(system, adapter, sourceJournal, 8453, 1, entry, now))
  assert.equal((await verifier.streams(adapter.address)).next.toNumber(), 1)
  await chain.send(broken.setExhaustion(false))
  await relayBatch(system, adapter, sourceJournal, 8453, 1, entry, now)
  assert.equal((await verifier.streams(adapter.address)).next.toNumber(), 2)
  const id = await adapter.positionId(1, 25, alice, false)
  assert.equal((await adapter.positions(id)).active, 1)
})
