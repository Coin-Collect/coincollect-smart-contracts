const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { ContractFactory, constants, utils } = require('ethers')
const { compile } = require('../scripts/compile.cjs')
const { startLocalAnvil } = require('../scripts/local-anvil.cjs')

test('a single ledger sustains 1,024 NFTs and 128 wallets with bounded four-reward operations', { timeout: 120_000 }, async (t) => {
  const entries = compile(['test/ScaleFixtures.sol'])
  const node = await startLocalAnvil()
  t.after(node.close)
  const { provider } = node
  const [governor, participant, successor] = await provider.listAccounts()
  const admin = provider.getSigner(governor)
  const alice = provider.getSigner(participant)
  const bob = provider.getSigner(successor)
  const deploy = async (file, name, ...args) => {
    const artifact = entries[file][name]
    return (await new ContractFactory(artifact.abi, '0x' + artifact.evm.bytecode.object, admin).deploy(...args)).deployed()
  }
  const send = async (tx) => {
    const { hash } = await tx
    for (let attempt = 0; attempt < 200; attempt++) {
      const receipt = await provider.send('eth_getTransactionReceipt', [hash])
      if (receipt) {
        assert.equal(receipt.status, '0x1', hash)
        return receipt
      }
      await delay(50)
    }
    throw new Error(`No mined receipt for ${hash}`)
  }
  const latest = async () => (await provider.getBlock('latest')).timestamp
  const at = async (time, tx) => {
    await provider.send('evm_setNextBlockTimestamp', [time])
    if (tx) return send(tx())
    await provider.send('evm_mine', [])
  }
  const gas = { gasLimit: 8_000_000 }
  const first = await deploy('test/Fixtures.sol', 'FixtureNft')
  const second = await deploy('test/Fixtures.sol', 'FixtureNft')
  const scaler = await deploy('test/ScaleFixtures.sol', 'ScaleFixtures')
  const assets = []
  for (const decimals of [6, 18, 6, 18]) assets.push(await deploy('test/Fixtures.sol', 'FixtureToken', decimals))
  const ledger = await deploy('contracts/UniversalRewards.sol', 'UniversalRewards', governor, governor,
    assets.map((token) => token.address), constants.AddressZero, constants.AddressZero, constants.AddressZero)
  const vault = await deploy('contracts/TreasuryVault.sol', 'TreasuryVault', ledger.address)
  await assert.rejects(ledger.connect(bob).callStatic.attachTreasuryVault(vault.address))
  await send(ledger.attachTreasuryVault(vault.address))
  await assert.rejects(vault.connect(bob).callStatic.setPaused(true))
  await send(vault.setPaused(true))
  await send(vault.setPaused(false))
  const reward = utils.parseUnits('10000000', 18)
  const start = (await latest()) + 120
  const end = start + 365 * 86400
  await send(ledger.createPool([start, end, 64, 1024, 8, ''],
    [[137, first.address, 1], [137, second.address, 3]], assets.map(({ address }) => [address, reward])))
  for (const token of assets) {
    await send(token.mint(governor, reward))
    await send(token.approve(ledger.address, reward))
    await send(ledger.fundReward(1, token.address, reward))
  }
  let inserted = 0
  const results = []
  await at(start)
  for (const size of [32, 128, 512, 1024]) {
    while (inserted < size) {
      const collection = inserted % 32 === 0 ? first : second
      await send(scaler.populate(ledger.address, 1, collection.address, 100 + inserted, 2, 8, gas))
      inserted += 16
    }
    const pool = await ledger.poolState(1)
    assert.equal(pool.activeNfts.toNumber(), size)
    assert.equal(pool.activeWallets, size / 8)
    assert.equal(pool.totalWeight.toNumber(), size * 2)
    const tokenId = 10_000 + size
    const key = await ledger.nftKey(137, first.address, tokenId)
    await send(first.mint(participant, tokenId))
    const join = await at((await latest()) + 120, () => ledger.connect(alice).join(1, 137, first.address, tokenId, gas))
    const checkpoint = await at((await latest()) + 60, () => ledger.checkpoint(1, gas))
    await send(first.connect(alice).transferFrom(participant, successor, tokenId))
    await assert.rejects(ledger.connect(alice).callStatic.claim(1, 137, first.address, tokenId))
    const reconcile = await at((await latest()) + 60, () => ledger.reconcile(1, [key], gas))
    const [keys, total] = await ledger.walletPositionKeys(1, successor, 0, 12)
    assert.equal(keys.at(-1), key)
    assert.equal(total.toNumber(), results.length + 1)
    const expected = await ledger.claimable(1, key, assets[0].address)
    assert.ok(expected.gt(0))
    const before = await assets[0].balanceOf(successor)
    const claim = await at((await latest()) + 60, () => ledger.connect(bob).claim(1, 137, first.address, tokenId, gas))
    assert.ok((await assets[0].balanceOf(successor)).sub(before).gte(expected))
    const exit = await at((await latest()) + 60, () => ledger.connect(bob).exit(1, 137, first.address, tokenId, gas))
    assert.equal(await first.ownerOf(tokenId), successor)
    assert.equal((await ledger.walletPositionStats(1, successor)).count, 0)
    const snapshot = await provider.send('evm_snapshot', [])
    const settlement = await at(end + 30 * 86400, () => ledger.connect(bob).recoverExpiredRewards(1, assets[0].address, gas))
    assert.equal((await ledger.rewardState(1, assets[0].address)).inventory.toString(), '0')
    assert.ok(await provider.send('evm_revert', [snapshot]))
    const row = { size, join, checkpoint, reconcile, claim, exit, settlement }
    const measured = Object.fromEntries(Object.entries(row).map(([name, value]) => [name, name === 'size' ? value : Number(value.gasUsed)]))
    t.diagnostic(JSON.stringify(measured))
    results.push(measured)
  }
  for (const name of ['join', 'checkpoint', 'reconcile', 'claim', 'exit', 'settlement']) {
    const smallest = Math.min(...results.map((row) => row[name]))
    const largest = Math.max(...results.map((row) => row[name]))
    assert.ok(largest < 700_000, `${name} exceeded the benchmark gas budget: ${largest}`)
    assert.ok(largest < smallest * 1.6, `${name} costs grew unexpectedly with pool size`)
  }
})

test('ERC-20 callbacks cannot reenter checkpoint or multiply payout credits', async (t) => {
  const entries = compile(['contracts/UniversalRewards.sol', 'test/Fixtures.sol'])
  const chain = await startLocalAnvil()
  t.after(chain.close)
  const { provider } = chain
  const [admin, user] = await provider.listAccounts()
  const governor = provider.getSigner(admin)
  const recipient = provider.getSigner(user)
  const deploy = async (file, name, ...args) => {
    const artifact = entries[file][name]
    return (await new ContractFactory(artifact.abi, '0x' + artifact.evm.bytecode.object, governor).deploy(...args)).deployed()
  }
  const send = async (tx) => (await tx).wait()
  const nft = await deploy('test/Fixtures.sol', 'FixtureNft')
  const token = await deploy('test/Fixtures.sol', 'FixtureCallbackToken')
  const zero = constants.AddressZero
  const ledger = await deploy('contracts/UniversalRewards.sol', 'UniversalRewards', admin, admin, [token.address], zero, zero, zero)
  const start = (await provider.getBlock('latest')).timestamp + 30
  await send(ledger.createPool([start, start + 100, 0, 2, 2, ''], [[137, nft.address, 1]], [[token.address, 100]]))
  await send(nft.mint(user, 1))
  await send(token.mint(admin, 100))
  await send(token.approve(ledger.address, 100))
  await send(ledger.fundReward(1, token.address, 100))
  await send(token.configureCallback(ledger.address, ledger.interface.encodeFunctionData('checkpoint', [1])))
  await provider.send('evm_setNextBlockTimestamp', [start])
  await send(ledger.connect(recipient).join(1, 137, nft.address, 1, { gasLimit: 500_000 }))
  const nonce = await recipient.getTransactionCount('pending')
  await provider.send('evm_setAutomine', [false])
  const [first, second] = await Promise.all([
    ledger.connect(recipient).claim(1, 137, nft.address, 1, { gasLimit: 500_000, nonce }),
    ledger.connect(recipient).claim(1, 137, nft.address, 1, { gasLimit: 500_000, nonce: nonce + 1 }),
  ])
  await provider.send('evm_setNextBlockTimestamp', [start + 101])
  await provider.send('evm_mine', [])
  const receipts = await Promise.all([first.wait(), second.wait()])
  assert.equal(receipts[0].blockNumber, receipts[1].blockNumber)
  assert.equal(await token.attempted(), true)
  assert.equal(await token.refusal(), utils.id('ReentrancyGuardReentrantCall()').slice(0, 10))
  assert.equal((await token.balanceOf(user)).toNumber(), 100)
  assert.equal(receipts.flatMap((receipt) => receipt.events).filter((event) => event.event === 'Claimed').length, 1)
})
