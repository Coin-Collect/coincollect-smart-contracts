const { before, after, test } = require('node:test')
const assert = require('node:assert/strict')
const { ContractFactory, constants } = require('ethers')
const { compile } = require('../scripts/compile.cjs')
const { startLocalAnvil } = require('../scripts/local-anvil.cjs')

const PRECISION = 10n ** 18n
const CLAIM_PERIOD = 30 * 86400
const units = (value, decimals) => BigInt(value) * 10n ** BigInt(decimals)
const gas = { gasLimit: 8_000_000 }
const nativeId = 137
let chain
let ledger
let primary
let secondary
let nft
let rare
let owner
let alice
let bob
let carol
let treasury
let accounts

async function deploy(artifact, ...args) {
  const factory = new ContractFactory(artifact.abi, '0x' + artifact.evm.bytecode.object, owner)
  return (await factory.deploy(...args)).deployed()
}

async function now() {
  return (await chain.provider.getBlock('latest')).timestamp
}

async function at(timestamp, submit) {
  await chain.provider.send('evm_setNextBlockTimestamp', [timestamp])
  if (!submit) {
    await chain.provider.send('evm_mine', [])
    return undefined
  }
  return (await submit()).wait()
}

async function makePool({ cap = 1000n, secondCap, duration = 100, threshold = 0, maxWallets = 6, maxNftsPerWallet = 3 } = {}) {
  const start = (await now()) + 30
  const end = start + duration
  const config = [start, end, threshold, maxWallets, maxNftsPerWallet, 'ipfs://fixture']
  const rewardConfigs = [[primary.address, cap]]
  if (secondCap !== undefined) rewardConfigs.push([secondary.address, secondCap])
  const receipt = await (await ledger.createPool(config, [[nativeId, nft.address, 1], [nativeId, rare.address, 3]], rewardConfigs)).wait()
  const id = receipt.events.find((event) => event.event === 'PoolCreated').args.poolId
  return { id, start, end }
}

async function fund(pool, token, amount) {
  await (await ledger.fundReward(pool.id, token.address, amount)).wait()
}

async function key(token, id) {
  return ledger.nftKey(nativeId, token.address, id)
}

async function claimable(pool, token, id, reward = primary) {
  return (await ledger.claimable(pool.id, await key(token, id), reward.address)).toBigInt()
}

async function walletBalance(token, wallet) {
  return (await token.balanceOf(wallet)).toBigInt()
}

async function mint(collection, wallet, id) {
  await (await collection.mint(wallet, id)).wait()
}

before(async () => {
  const entries = compile(['contracts/UniversalRewards.sol', 'test/Fixtures.sol'])
  const { FixtureNft, FixtureToken } = entries['test/Fixtures.sol']
  chain = await startLocalAnvil()
  accounts = await chain.provider.listAccounts()
  ;[owner, alice, bob, carol] = accounts.slice(0, 4).map((address) => chain.provider.getSigner(address))
  treasury = accounts[4]
  primary = await deploy(FixtureToken, 6)
  secondary = await deploy(FixtureToken, 18)
  nft = await deploy(FixtureNft)
  rare = await deploy(FixtureNft)
  ledger = await deploy(entries['contracts/UniversalRewards.sol'].UniversalRewards, accounts[0], treasury, [primary.address, secondary.address], constants.AddressZero, constants.AddressZero, constants.AddressZero)
  for (const token of [primary, secondary]) {
    await mint(token, accounts[0], 10n ** 32n)
    await (await token.approve(ledger.address, constants.MaxUint256)).wait()
  }
})

after(() => chain?.close())

test('NFT stays in the wallet and transfers carry vested rewards, even after a prior owner claimed', async () => {
  await mint(nft, accounts[1], 1)
  const pool = await makePool()
  await fund(pool, primary, 1000n)
  await at(pool.start, () => ledger.connect(alice).join(pool.id, nativeId, nft.address, 1, gas))
  assert.equal(await nft.ownerOf(1), accounts[1])
  assert.equal(await nft.getApproved(1), constants.AddressZero)

  await at(pool.start + 20, () => ledger.connect(alice).claim(pool.id, nativeId, nft.address, 1, gas))
  assert.equal(await walletBalance(primary, accounts[1]), 200n)
  await at(pool.start + 30, () => nft.connect(alice).transferFrom(accounts[1], accounts[2], 1))
  assert.equal(await claimable(pool, nft, 1), 100n)
  await assert.rejects(ledger.connect(alice).callStatic.claim(pool.id, nativeId, nft.address, 1))
  await at(pool.start + 40, () => nft.connect(bob).transferFrom(accounts[2], accounts[3], 1))
  await assert.rejects(ledger.connect(bob).callStatic.claim(pool.id, nativeId, nft.address, 1))
  const carolBefore = await walletBalance(primary, accounts[3])
  await at(pool.start + 50, () => ledger.connect(carol).exit(pool.id, nativeId, nft.address, 1, gas))
  assert.equal(await walletBalance(primary, accounts[3]) - carolBefore, 300n)
  assert.equal(await (await ledger.positionState(pool.id, await key(nft, 1))).seatOwner, constants.AddressZero)
  assert.equal(await nft.ownerOf(1), accounts[3])

  await at(pool.start + 70, () => ledger.connect(carol).claim(pool.id, nativeId, nft.address, 1, gas))
  assert.equal(await walletBalance(primary, accounts[3]) - carolBefore, 300n)
  assert.equal(await walletBalance(primary, accounts[1]), 200n)
})

test('checkpoint applies distinct wallet threshold, mixed powers, partial entry, and independent token decimals', async () => {
  await mint(nft, accounts[1], 2)
  await mint(rare, accounts[1], 3)
  await mint(nft, accounts[2], 4)
  const cap = units(100, 6)
  const secondCap = units(200, 18)
  const pool = await makePool({ cap, secondCap, threshold: 2 })
  await fund(pool, primary, cap)
  await fund(pool, secondary, secondCap)
  await at(pool.start, () => ledger.connect(alice).join(pool.id, nativeId, nft.address, 2, gas))
  await at(pool.start + 10, () => ledger.connect(alice).join(pool.id, nativeId, rare.address, 3, gas))
  await at(pool.start + 30, () => ledger.connect(bob).join(pool.id, nativeId, nft.address, 4, gas))
  await at(pool.start + 50)

  assert.equal((await ledger.poolState(pool.id)).activeWallets, 2)
  assert.equal((await ledger.poolState(pool.id)).activeNfts.toNumber(), 3)
  assert.equal((await ledger.poolState(pool.id)).totalWeight.toNumber(), 5)
  assert.equal(await claimable(pool, nft, 2), 11_500_000n)
  assert.equal(await claimable(pool, rare, 3), 19_500_000n)
  assert.equal(await claimable(pool, nft, 4), units(4, 6))
  assert.equal(await claimable(pool, rare, 3, secondary), units(39, 18))
})

test('wallet and NFT caps are distinct and transfer invalidation leaves claimable credits', async () => {
  await mint(nft, accounts[1], 10)
  await mint(nft, accounts[2], 11)
  await mint(nft, accounts[2], 12)
  await mint(nft, accounts[3], 13)
  const pool = await makePool({ maxWallets: 2, maxNftsPerWallet: 1 })
  await fund(pool, primary, 1000n)
  await at(pool.start, () => ledger.connect(alice).join(pool.id, nativeId, nft.address, 10, gas))
  await at(pool.start + 1, () => ledger.connect(bob).join(pool.id, nativeId, nft.address, 11, gas))
  await assert.rejects(ledger.connect(bob).callStatic.join(pool.id, nativeId, nft.address, 12))
  await assert.rejects(ledger.connect(carol).callStatic.join(pool.id, nativeId, nft.address, 13))
  await at(pool.start + 11, () => nft.connect(alice).transferFrom(accounts[1], accounts[2], 10))
  await at(pool.start + 12, () => ledger.checkpoint(pool.id, gas))
  const transferred = await ledger.positionState(pool.id, await key(nft, 10))
  assert.equal(transferred.seatOwner, constants.AddressZero)
  assert.equal((await ledger.poolState(pool.id)).activeWallets, 1)
  assert.equal(await claimable(pool, nft, 10), 65n)
  assert.equal(await claimable(pool, nft, 11), 55n)
  await assert.rejects(ledger.connect(alice).callStatic.claim(pool.id, nativeId, nft.address, 10))
  await at(pool.start + 13, () => ledger.connect(carol).join(pool.id, nativeId, nft.address, 13, gas))
  const balance = await walletBalance(primary, accounts[2])
  await at(pool.start + 14, () => ledger.connect(bob).claim(pool.id, nativeId, nft.address, 10, gas))
  assert.equal(await walletBalance(primary, accounts[2]) - balance, 65n)
})

test('underfunding cannot retroactively earn and ended pools return only surplus to immutable treasury', async () => {
  await mint(nft, accounts[1], 20)
  const pool = await makePool()
  const otherPool = await makePool()
  await fund(pool, primary, 50n)
  await fund(otherPool, primary, 80n)
  await at(pool.start, () => ledger.connect(alice).join(pool.id, nativeId, nft.address, 20, gas))
  await at(pool.start + 50, () => ledger.fundReward(pool.id, primary.address, 1000n, gas))
  assert.equal(await claimable(pool, nft, 20), 50n)
  await assert.rejects(ledger.callStatic.recoverSurplus(pool.id, primary.address))
  const treasuryBefore = await walletBalance(primary, treasury)
  await at(pool.end + 1, () => ledger.connect(carol).recoverSurplus(pool.id, primary.address, gas))
  assert.equal(await walletBalance(primary, treasury) - treasuryBefore, 500n)
  const reserved = await ledger.rewardState(pool.id, primary.address)
  assert.equal(reserved.inventory.toBigInt(), 550n)
  assert.equal(reserved.committed.toBigInt(), 550n * PRECISION)
  assert.equal((await ledger.rewardState(otherPool.id, primary.address)).inventory.toBigInt(), 80n)

  const aliceBefore = await walletBalance(primary, accounts[1])
  await at(pool.end + 15 * 86400, () => nft.connect(alice).transferFrom(accounts[1], accounts[2], 20))
  const bobBefore = await walletBalance(primary, accounts[2])
  await assert.rejects(ledger.connect(alice).callStatic.exit(pool.id, nativeId, nft.address, 20))
  const receipt = await at(pool.end + CLAIM_PERIOD - 1, () => ledger.connect(bob).exit(pool.id, nativeId, nft.address, 20, gas))
  assert.equal((await chain.provider.getBlock(receipt.blockNumber)).timestamp, pool.end + CLAIM_PERIOD - 1)
  assert.equal(await walletBalance(primary, accounts[2]) - bobBefore, 550n)
  assert.equal(await walletBalance(primary, accounts[1]), aliceBefore)
  assert.equal((await ledger.rewardState(pool.id, primary.address)).inventory.toBigInt(), 0n)
})

test('the exact claim deadline closes all payouts and lets anyone settle each token independently', async () => {
  assert.equal((await ledger.CLAIM_PERIOD()).toNumber(), CLAIM_PERIOD)
  await mint(nft, accounts[1], 21)
  await mint(nft, accounts[1], 22)
  const pool = await makePool({ secondCap: 3001n })
  const other = await makePool()
  await fund(pool, primary, 70n)
  await fund(pool, secondary, 3001n)
  await fund(other, primary, 80n)
  await at(pool.start, () => ledger.connect(alice).joinBatch(pool.id, [
    [nativeId, nft.address, 21], [nativeId, nft.address, 22],
  ], gas))
  await at(pool.end - 1, () => secondary.setTransfersBlocked(true))

  const deadline = pool.end + CLAIM_PERIOD
  await at(deadline - 1)
  const position = [pool.id, nativeId, nft.address, 21]
  assert.equal(await claimable(pool, nft, 21), 35n)
  const [liability] = await ledger.rewardSettlement(pool.id, secondary.address)
  assert.equal(liability.toBigInt(), 3001n * PRECISION)
  assert.equal(await claimable(pool, nft, 21, secondary), 1500n)
  assert.equal(await claimable(pool, nft, 22, secondary), 1500n)
  await ledger.connect(alice).callStatic.claimReward(...position, primary.address)
  await assert.rejects(ledger.connect(carol).callStatic.recoverExpiredRewards(pool.id, primary.address),
    { errorName: 'ClaimPeriodOpen' })

  const primaryBefore = await walletBalance(primary, treasury)
  await at(deadline, () => ledger.connect(carol).recoverExpiredRewards(pool.id, primary.address, gas))
  assert.equal(await now(), deadline)
  assert.equal(await walletBalance(primary, treasury) - primaryBefore, 70n)
  assert.equal(await claimable(pool, nft, 21), 0n)
  assert.equal(await claimable(pool, nft, 22, secondary), 0n)
  assert.equal((await ledger.rewardSettlement(pool.id, secondary.address)).claimLiability.toBigInt(), 0n)
  for (const [name, args] of [['claim', position], ['claimReward', [...position, primary.address]], ['exit', position]]) {
    await assert.rejects(ledger.connect(alice).callStatic[name](...args), { errorName: 'ClaimPeriodEnded' })
  }
  assert.equal((await ledger.callStatic.recoverExpiredRewards(pool.id, primary.address)).toBigInt(), 0n)
  assert.equal((await ledger.callStatic.recoverSurplus(pool.id, primary.address)).toBigInt(), 0n)
  assert.equal((await ledger.rewardState(other.id, primary.address)).inventory.toBigInt(), 80n)

  await assert.rejects(ledger.callStatic.recoverExpiredRewards(pool.id, secondary.address))
  assert.equal((await ledger.rewardState(pool.id, secondary.address)).inventory.toBigInt(), 3001n)
  assert.equal((await ledger.rewardSettlement(pool.id, secondary.address)).expiredRecovered.toBigInt(), 0n)
  await (await ledger.connect(alice).leave(...position, gas)).wait()
  await (await secondary.setTransfersBlocked(false)).wait()
  const secondaryBefore = await walletBalance(secondary, treasury)
  await (await ledger.connect(bob).recoverSurplus(pool.id, secondary.address, gas)).wait()
  assert.equal(await walletBalance(secondary, treasury) - secondaryBefore, 3001n)
  const settled = await ledger.rewardState(pool.id, secondary.address)
  assert.equal(settled.inventory.toBigInt(), 0n)
  assert.equal(settled.committed.toBigInt(), 0n)
  assert.equal((await ledger.rewardSettlement(pool.id, secondary.address)).expiredRecovered.toBigInt(), 3001n)
  assert.equal((await ledger.callStatic.recoverExpiredRewards(pool.id, secondary.address)).toBigInt(), 0n)
})

test('one blocked reward does not prevent the NFT owner from leaving and claiming independently', async () => {
  await mint(nft, accounts[1], 30)
  const pool = await makePool({ secondCap: 3000n })
  await fund(pool, primary, 1000n)
  await fund(pool, secondary, 3000n)
  await at(pool.start, () => ledger.connect(alice).join(pool.id, nativeId, nft.address, 30, gas))
  await at(pool.start + 30, () => secondary.setTransfersBlocked(true))
  await assert.rejects(ledger.connect(alice).callStatic.exit(pool.id, nativeId, nft.address, 30))
  await at(pool.start + 40, () => ledger.connect(alice).leave(pool.id, nativeId, nft.address, 30, gas))
  assert.equal(await claimable(pool, nft, 30), 400n)
  assert.equal(await claimable(pool, nft, 30, secondary), 1200n)
  await at(pool.start + 50, () => ledger.connect(alice).claimReward(pool.id, nativeId, nft.address, 30, primary.address, gas))
  assert.equal(await claimable(pool, nft, 30), 0n)
  assert.equal(await claimable(pool, nft, 30, secondary), 1200n)
  await (await secondary.setTransfersBlocked(false)).wait()
})

test('tracked reserves conserve actual payouts across randomized transfers, joins, exits, and top-ups', async () => {
  const users = [alice, bob, carol]
  const wallets = accounts.slice(1, 4)
  let seed = 0x9e3779b9
  const pick = (size) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (seed >>> 8) % size
  }

  for (let run = 0; run < 6; run++) {
    const pool = await makePool({
      cap: 1_003n,
      secondCap: 673n,
      duration: 120,
      maxWallets: 3,
      maxNftsPerWallet: 6,
      threshold: pick(4),
    })
    const positions = []
    for (let index = 0; index < 6; index++) {
      const collection = index % 2 === 0 ? nft : rare
      const id = 100 + run * 6 + index
      const walletIndex = pick(users.length)
      await mint(collection, wallets[walletIndex], id)
      positions.push({ collection, id, key: await key(collection, id), walletIndex })
    }

    const initialBalances = await Promise.all(
      [primary, secondary].map(async (token) => ({
        held: await walletBalance(token, ledger.address),
        paid: await Promise.all(wallets.map((wallet) => walletBalance(token, wallet))),
        surplus: await walletBalance(token, treasury),
      })),
    )
    const raised = [1_103n, 103n]
    await fund(pool, primary, raised[0])
    await fund(pool, secondary, raised[1])
    // A zero-participant interval must not allocate rewards even when the reserve is full.
    await at(pool.start + 4, () => ledger.checkpoint(pool.id, gas))
    assert.equal((await ledger.rewardState(pool.id, primary.address)).committed.toBigInt(), 0n)

    for (let step = 0; step < 28; step++) {
      const timestamp = pool.start + (step + 2) * 4
      const position = positions[pick(positions.length)]
      const { collection, id, walletIndex } = position
      const signer = ledger.connect(users[walletIndex])
      const active = (await ledger.positionState(pool.id, position.key)).seatOwner !== constants.AddressZero
      switch (pick(5)) {
        case 0:
          if (!active) {
            await at(timestamp, () => signer.join(pool.id, nativeId, collection.address, id, gas))
          }
          break
        case 1:
          if (active) {
            await at(timestamp, () => signer.exit(pool.id, nativeId, collection.address, id, gas))
          }
          break
        case 2: {
          const nextWallet = (walletIndex + 1 + pick(2)) % users.length
          await at(timestamp, () => collection.connect(users[walletIndex]).transferFrom(wallets[walletIndex], wallets[nextWallet], id))
          position.walletIndex = nextWallet
          break
        }
        case 3: {
          const rewardIndex = pick(2)
          const amount = BigInt(1 + pick(53))
          const token = [primary, secondary][rewardIndex]
          await at(timestamp, () => ledger.fundReward(pool.id, token.address, amount, gas))
          raised[rewardIndex] += amount
          break
        }
        default:
          await at(timestamp, () => ledger.checkpoint(pool.id, gas))
      }

      for (const [index, token] of [primary, secondary].entries()) {
        const { inventory, committed, cap } = await ledger.rewardState(pool.id, token.address)
        const balance = await walletBalance(token, ledger.address)
        const paid = await Promise.all(wallets.map((wallet) => walletBalance(token, wallet)))
        const claimed = paid.reduce((total, value, i) => total + value - initialBalances[index].paid[i], 0n)
        assert.equal(raised[index], claimed + inventory.toBigInt())
        assert.equal(balance - initialBalances[index].held, inventory.toBigInt())
        assert.ok(committed.toBigInt() <= inventory.toBigInt() * PRECISION)
        assert.ok(claimed * PRECISION + committed.toBigInt() <= cap.toBigInt() * PRECISION)
      }
    }

    await at(pool.end + 1, () => ledger.checkpoint(pool.id, gas))
    for (const position of positions) {
      if ((await ledger.positionState(pool.id, position.key)).collection !== constants.AddressZero) {
        await (await ledger.connect(users[position.walletIndex]).claim(pool.id, nativeId, position.collection.address, position.id, gas)).wait()
      }
    }
    for (const [index, token] of [primary, secondary].entries()) {
      await (await ledger.recoverSurplus(pool.id, token.address, gas)).wait()
      const paid = await Promise.all(wallets.map((wallet) => walletBalance(token, wallet)))
      const claimed = paid.reduce((total, value, i) => total + value - initialBalances[index].paid[i], 0n)
      const recovered = (await walletBalance(token, treasury)) - initialBalances[index].surplus
      assert.equal(raised[index], claimed + recovered)
      assert.equal(await walletBalance(token, ledger.address), initialBalances[index].held)
    }
  }
})

test('maximum roster settles four independent reward tokens within the measured gas bound', async (t) => {
  const entries = compile(['test/Fixtures.sol'])
  const tokenArtifact = entries['test/Fixtures.sol'].FixtureToken
  const third = await deploy(tokenArtifact, 6)
  const fourth = await deploy(tokenArtifact, 18)
  const rewards = [primary, secondary, third, fourth]
  const separateLedger = await deploy(
    compile()['contracts/UniversalRewards.sol'].UniversalRewards,
    accounts[0],
    treasury,
    rewards.map((token) => token.address),
    constants.AddressZero,
    constants.AddressZero,
    constants.AddressZero,
  )
  for (const token of rewards) {
    if (token === third || token === fourth) await mint(token, accounts[0], 10_000n)
    await (await token.approve(separateLedger.address, 10_000n)).wait()
  }
  for (let i = 0; i < 33; i++) await mint(nft, accounts[1], 200 + i)
  const start = (await now()) + 30
  await (await separateLedger.createPool(
    [start, start + 10_000, 0, 1, 32, ''],
    [[nativeId, nft.address, 1]],
    rewards.map((token) => [token.address, 10_000n]),
  )).wait()
  for (const token of rewards) await (await separateLedger.fundReward(1, token.address, 10_000n)).wait()
  for (let i = 0; i < 32; i++) {
    await at(start + i + 1, () => separateLedger.connect(alice).join(1, nativeId, nft.address, 200 + i, gas))
  }
  await assert.rejects(separateLedger.connect(alice).callStatic.join(1, nativeId, nft.address, 232))
  const receipt = await at(start + 2000, () => separateLedger.checkpoint(1, gas))
  assert.equal((await separateLedger.poolState(1)).activeNfts.toNumber(), 32)
  assert.ok(receipt.gasUsed.toNumber() < 4_000_000)
  t.diagnostic('32-NFT, four-token local checkpoint: ' + receipt.gasUsed.toString() + ' gas')
})
