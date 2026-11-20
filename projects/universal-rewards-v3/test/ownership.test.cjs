const { before, after, test } = require('node:test')
const assert = require('node:assert/strict')
const { ContractFactory, Wallet, constants, utils } = require('ethers')
const { compile } = require('../scripts/compile.cjs')
const { startLocalAnvil } = require('../scripts/local-anvil.cjs')

const local = 137
const base = 8453
const arbitrum = 42161
const sources = [[base, 60, 3600], [arbitrum, 60, 3600]]
const config = { name: 'CoinCollect Finalized Ownership', version: '1', chainId: 31337 }
const gas = { gasLimit: 8_000_000 }
const types = {
  OwnershipObservation: [
    ['sourceChainId', 'uint256'],
    ['collection', 'address'],
    ['tokenId', 'uint256'],
    ['owner', 'address'],
    ['sourceBlock', 'uint64'],
    ['sourceBlockHash', 'bytes32'],
    ['sourceTimestamp', 'uint64'],
    ['issuedAt', 'uint64'],
    ['validUntil', 'uint64'],
  ].map(([name, type]) => ({ name, type })),
}
// Offline-only fixture signing keys. No chain account uses them.
const witnesses = ['11', '22', '33'].map((byte) => new Wallet('0x' + byte.repeat(32)))
  .sort((left, right) => left.address.toLowerCase().localeCompare(right.address.toLowerCase()))
const rogue = new Wallet('0x' + '44'.repeat(32))
let chain, admin, alice, bob, accounts, nft, reward, verifier, otherVerifier, ledger, ledgerArtifact

async function deploy(artifact, ...args) {
  return (await new ContractFactory(artifact.abi, '0x' + artifact.evm.bytecode.object, admin).deploy(...args)).deployed()
}

async function now() {
  return (await chain.provider.getBlock('latest')).timestamp
}

async function transact(pending) {
  return (await pending).wait()
}

async function at(timestamp, send) {
  await chain.provider.send('evm_setNextBlockTimestamp', [timestamp])
  if (send) return transact(send())
  return chain.provider.send('evm_mine', [])
}

async function observation(fields = {}) {
  const time = await now()
  return {
    sourceChainId: base,
    collection: nft.address,
    tokenId: 1,
    owner: accounts[1],
    sourceBlock: 100,
    sourceBlockHash: utils.keccak256('0x1234'),
    sourceTimestamp: time - 120,
    issuedAt: time,
    validUntil: time + 1000,
    ...fields,
  }
}

function sign(data, signers = witnesses.slice(0, 2), domain = {}) {
  return Promise.all(signers.map((witness) =>
    witness._signTypedData({ ...config, verifyingContract: verifier.address, ...domain }, types, data)))
}

async function publish(data) {
  return transact(verifier.connect(bob).record(data, await sign(data)))
}

async function createPool({ collections, duration = 600, cap = 18000n, maxNfts = 2 } = {}) {
  const start = (await now()) + 80
  const receipt = await transact(ledger.createPool(
    [start, start + duration, 0, 2, maxNfts, ''],
    collections,
    [[reward.address, cap]],
  ))
  const poolId = receipt.events.find(({ event }) => event === 'PoolCreated').args.poolId
  await transact(ledger.fundReward(poolId, reward.address, cap))
  return { start, end: start + duration, poolId }
}

before(async () => {
  const compiled = compile(['contracts/UniversalRewards.sol', 'test/Fixtures.sol'])
  const fixtures = compiled['test/Fixtures.sol']
  const verifierArtifact = compiled['contracts/FinalizedOwnershipVerifier.sol'].FinalizedOwnershipVerifier
  ledgerArtifact = compiled['contracts/UniversalRewards.sol'].UniversalRewards
  chain = await startLocalAnvil()
  accounts = await chain.provider.listAccounts()
  ;[admin, alice, bob] = accounts.slice(0, 3).map((address) => chain.provider.getSigner(address))
  nft = await deploy(fixtures.FixtureNft)
  reward = await deploy(fixtures.FixtureToken, 6)
  const configuredWitnesses = witnesses.map(({ address }) => address)
  verifier = await deploy(verifierArtifact, configuredWitnesses, 2, sources)
  otherVerifier = await deploy(verifierArtifact, configuredWitnesses, 2, sources)
  ledger = await deploy(
    ledgerArtifact, accounts[0], accounts[3], [reward.address], constants.AddressZero, constants.AddressZero, verifier.address,
  )
  await transact(reward.mint(accounts[0], 1_000_000n))
  await transact(reward.approve(ledger.address, constants.MaxUint256))
})

after(() => chain?.close())

test('quorum evidence rejects spoofing, wrong domain, duplicate signatures, stale and non-monotonic observations', async () => {
  const data = await observation()
  await assert.rejects(verifier.callStatic.record(data, await sign(data, [witnesses[0]])))
  await assert.rejects(verifier.callStatic.record(data, await sign(data, [witnesses[0], witnesses[0]])))
  await assert.rejects(verifier.callStatic.record(data, await sign(data, [witnesses[1], witnesses[0]])))
  await assert.rejects(verifier.callStatic.record(data, await sign(data, [witnesses[0], rogue])))
  await assert.rejects(verifier.callStatic.record(data, await sign(data, undefined, { chainId: 137 })))
  await assert.rejects(otherVerifier.callStatic.record(data, await sign(data)))
  await assert.rejects(verifier.callStatic.record({ ...data, owner: accounts[2] }, await sign(data)))

  for (const override of [
    { sourceChainId: 1 },
    { sourceBlockHash: constants.HashZero },
    { sourceTimestamp: data.issuedAt - 5 },
    { sourceTimestamp: data.issuedAt - 4000 },
    { issuedAt: data.issuedAt + 60 },
    { validUntil: data.issuedAt - 1 },
    { validUntil: data.issuedAt + 1201 },
  ]) {
    const invalid = { ...data, ...override }
    await assert.rejects(verifier.callStatic.record(invalid, await sign(invalid)))
  }

  await publish(data)
  await assert.rejects(verifier.callStatic.record(data, await sign(data)))
  const conflicting = { ...data, sourceBlockHash: utils.keccak256('0x9999'), owner: accounts[2] }
  await assert.rejects(verifier.callStatic.record(conflicting, await sign(conflicting)))
  const staleSource = { ...data, sourceBlock: data.sourceBlock + 1, sourceTimestamp: data.sourceTimestamp - 1 }
  await assert.rejects(verifier.callStatic.record(staleSource, await sign(staleSource)))
  assert.equal((await verifier.freshOwner(base, nft.address, 1)).owner, accounts[1])

  const polygonOnly = await deploy(
    ledgerArtifact, accounts[0], accounts[3], [reward.address], constants.AddressZero, constants.AddressZero, constants.AddressZero,
  )
  const time = (await now()) + 30
  await assert.rejects(polygonOnly.callStatic.createPool([time, time + 3600, 0, 3, 3, ''], [[base, nft.address, 1]], [[reward.address, 1]]))
})

test('three source identities share one pool, reward ledger and wallet caps', async () => {
  const tokenId = 10
  await transact(nft.mint(accounts[1], tokenId))
  const { poolId, start } = await createPool({
    collections: [[local, nft.address, 1], [base, nft.address, 2], [arbitrum, nft.address, 3]],
  })
  await publish(await observation({ tokenId }))
  await publish(await observation({ tokenId, sourceChainId: arbitrum, owner: accounts[2] }))
  await at(start, () => ledger.connect(alice).joinBatch(poolId, [[local, nft.address, tokenId], [base, nft.address, tokenId]], gas))
  await assert.rejects(ledger.connect(alice).callStatic.join(poolId, arbitrum, nft.address, tokenId))
  await assert.rejects(ledger.connect(bob).callStatic.join(poolId, base, nft.address, tokenId))
  await at(start + 10, () => ledger.connect(bob).join(poolId, arbitrum, nft.address, tokenId, gas))

  const state = await ledger.poolState(poolId)
  assert.equal(state.activeWallets, 2)
  assert.equal(state.totalWeight.toNumber(), 6)
  assert.equal(state.activeNfts.toNumber(), 3)
  assert.equal(await nft.ownerOf(tokenId), accounts[1])
  const baseKey = await ledger.nftKey(base, nft.address, tokenId)
  const localKey = await ledger.nftKey(local, nft.address, tokenId)
  assert.notEqual(baseKey, localKey)
  assert.notEqual(await ledger.nftKey(arbitrum, nft.address, tokenId), baseKey)
  const [firstTwo, total] = await ledger.positionKeys(poolId, 0, 2)
  assert.deepEqual(firstTwo, [localKey, baseKey])
  assert.equal(total.toNumber(), 3)
  await assert.rejects(ledger.positionKeys(poolId, 0, 33))

  const transferred = await observation({ tokenId, owner: accounts[2], sourceBlock: 101, sourceBlockHash: utils.keccak256('0x4321') })
  const signatures = await sign(transferred)
  await at(start + 50, () => verifier.record(transferred, signatures, gas))
  await assert.rejects(ledger.connect(alice).callStatic.claim(poolId, base, nft.address, tokenId))
  const before = await reward.balanceOf(accounts[2])
  await at(start + 51, () => ledger.connect(bob).claim(poolId, base, nft.address, tokenId, gas))
  assert.equal((await reward.balanceOf(accounts[2])).sub(before).toBigInt(), 610n)
  assert.equal((await ledger.positionState(poolId, baseKey)).seatOwner, accounts[2])
  assert.equal((await ledger.walletsNftCount(poolId, accounts[2])).toNumber(), 2)

  // A Polygon transfer would be a third seat for Bob across the same shared pool.
  await at(start + 55, () => nft.connect(alice).transferFrom(accounts[1], accounts[2], tokenId))
  await at(start + 56, () => ledger.checkpoint(poolId, gas))
  assert.equal((await ledger.positionState(poolId, localKey)).seatOwner, constants.AddressZero)
  assert.equal((await ledger.walletsNftCount(poolId, accounts[2])).toNumber(), 2)
  assert.equal((await ledger.poolState(poolId)).activeWallets, 1)
  assert.ok((await ledger.claimable(poolId, localKey, reward.address)).gt(0))
  await assert.rejects(ledger.connect(alice).callStatic.claim(poolId, local, nft.address, tokenId))
  await assert.rejects(ledger.connect(bob).callStatic.join(poolId, local, nft.address, tokenId))
})

test('expiry stops remote earning and a fresh superior observation recovers the balance after pool end', async () => {
  const tokenId = 20
  const { poolId, start, end } = await createPool({ collections: [[arbitrum, nft.address, 1]], duration: 300, cap: 3000n })
  await publish(await observation({ sourceChainId: arbitrum, tokenId, validUntil: start + 40 }))
  await at(start, () => ledger.connect(alice).join(poolId, arbitrum, nft.address, tokenId, gas))
  await at(start + 70, () => ledger.checkpoint(poolId, gas))
  const key = await ledger.nftKey(arbitrum, nft.address, tokenId)
  assert.equal((await ledger.claimable(poolId, key, reward.address)).toBigInt(), 400n)
  assert.equal((await ledger.positionState(poolId, key)).seatOwner, constants.AddressZero)
  await assert.rejects(ledger.connect(alice).callStatic.claim(poolId, arbitrum, nft.address, tokenId))

  await at(end + 15 * 86400)
  await publish(await observation({ sourceChainId: arbitrum, tokenId, owner: accounts[2], sourceBlock: 101 }))
  await assert.rejects(ledger.connect(alice).callStatic.claim(poolId, arbitrum, nft.address, tokenId))
  const balance = await reward.balanceOf(accounts[2])
  await transact(ledger.connect(bob).exit(poolId, arbitrum, nft.address, tokenId, gas))
  assert.equal((await reward.balanceOf(accounts[2])).sub(balance).toBigInt(), 400n)
  await transact(ledger.connect(bob).claim(poolId, arbitrum, nft.address, tokenId, gas))
  assert.equal((await reward.balanceOf(accounts[2])).sub(balance).toBigInt(), 400n)
  await publish(await observation({ sourceChainId: arbitrum, tokenId, owner: constants.AddressZero, sourceBlock: 102 }))
  await assert.rejects(ledger.connect(bob).callStatic.claim(poolId, arbitrum, nft.address, tokenId))
})
