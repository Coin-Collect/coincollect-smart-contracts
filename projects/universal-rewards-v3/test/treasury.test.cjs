const { before, after, test } = require('node:test')
const assert = require('node:assert/strict')
const { ContractFactory, constants, utils } = require('ethers')
const { compile } = require('../scripts/compile.cjs')
const { startLocalAnvil } = require('../scripts/local-anvil.cjs')

const zero = constants.AddressZero
const usdt = (value) => utils.parseUnits(String(value), 6)
const day = 86_400
const gas = { gasLimit: 8_000_000 }
let chain, entries, ledger, vault, stable, wrapped, nft, admin, owner, user, operator, treasury, participant

async function deploy(name, file, ...args) {
  const artifact = entries[file][name]
  return (await new ContractFactory(artifact.abi, '0x' + artifact.evm.bytecode.object, admin).deploy(...args)).deployed()
}

const send = async (pending) => (await pending).wait()
const now = async () => (await chain.provider.getBlock('latest')).timestamp
async function at(time) {
  await chain.provider.send('evm_setNextBlockTimestamp', [time])
  await chain.provider.send('evm_mine', [])
}

async function treasuryBalance({ available, allocated, spent, fundingReturned, rewardsReturned, withdrawn }) {
  const row = await vault.balance(stable.address)
  for (const [field, value] of Object.entries({ available, allocated, spent, fundingReturned, rewardsReturned, withdrawn })) {
    if (value !== undefined) assert.equal(row[field].toString(), usdt(value).toString(), field)
  }
}

before(async () => {
  entries = compile(['contracts/UniversalRewards.sol', 'test/Fixtures.sol', 'test/SwapFixtures.sol'])
  chain = await startLocalAnvil()
  ;[operator, treasury, participant] = await chain.provider.listAccounts()
  ;[admin, owner, user] = [operator, treasury, participant].map((address) => chain.provider.getSigner(address))
  stable = await deploy('FixtureToken', 'test/Fixtures.sol', 6)
  wrapped = await deploy('FixtureWrapped', 'test/SwapFixtures.sol')
  nft = await deploy('FixtureNft', 'test/Fixtures.sol')
  ledger = await deploy(
    'UniversalRewards', 'contracts/UniversalRewards.sol',
    operator, treasury, [stable.address, wrapped.address], wrapped.address, zero, zero,
  )
  vault = await deploy('TreasuryVault', 'contracts/TreasuryVault.sol', ledger.address)
  await assert.rejects(ledger.callStatic.attachTreasuryVault(vault.address))
  await send(ledger.connect(owner).attachTreasuryVault(vault.address))
  await assert.rejects(ledger.connect(owner).callStatic.attachTreasuryVault(vault.address))
})
after(() => chain?.close())

test('one deposit finances independent 10 and 50 USDT pools and preserves claims across treasury withdrawals', async () => {
  await send(stable.mint(treasury, usdt(1000)))
  await send(stable.connect(owner).approve(vault.address, usdt(1000)))
  await send(vault.connect(owner).deposit(stable.address, usdt(1000)))
  await treasuryBalance({ available: 1000, allocated: 0 })
  const start = (await now()) + 60
  const end = start + 365 * day
  const buyPool = (budget, initial) => ledger.createTreasuryFundedPool(
    [start, end, 1, 2, 2, ''], [[137, nft.address, 1]], [[stable.address, usdt(budget)]],
    [stable.address, usdt(budget), day, [10000]], usdt(initial), true, gas,
  )
  await send(buyPool(10, 10))
  await treasuryBalance({ available: 990, allocated: 10 })
  await send(buyPool(50, 20))
  await treasuryBalance({ available: 970, allocated: 30 })
  await send(ledger.allocateTreasuryBudget(2, usdt(30)))
  await treasuryBalance({ available: 940, allocated: 60, withdrawn: 0 })
  await assert.rejects(vault.callStatic.withdraw(stable.address, usdt(1)))
  await assert.rejects(vault.connect(user).callStatic.withdraw(stable.address, usdt(1)))
  await assert.rejects(vault.connect(owner).callStatic.withdraw(stable.address, usdt(941)))
  await send(vault.connect(owner).withdraw(stable.address, usdt(500)))
  await treasuryBalance({ available: 440, allocated: 60, withdrawn: 500 })
  await assert.rejects(ledger.connect(user).callStatic.allocateTreasuryBudget(2, usdt(1)))
  await assert.rejects(ledger.callStatic.allocateTreasuryBudget(2, usdt(1)))
  await assert.rejects(ledger.callStatic.fundBudget(2, usdt(1)))
  await assert.rejects(ledger.callStatic.recoverBudget(2))
  await assert.rejects(buyPool(500, 500).then((tx) => tx.wait()))
  assert.equal((await ledger.poolCount()).toNumber(), 2)

  const [epoch, maximum] = await ledger.nextReplenishment(1, stable.address)
  assert.equal(maximum.toString(), usdt(10).toString())
  await send(vault.connect(owner).setPaused(true))
  assert.equal((await ledger.nextReplenishment(1, stable.address)).amount.toString(), '0')
  await assert.rejects(vault.connect(owner).callStatic.withdraw(stable.address, usdt(1)))
  await send(vault.connect(owner).setPaused(false))
  const deadline = (await now()) + 90
  const attempts = await Promise.allSettled([user, owner].map(
    (signer) => send(ledger.connect(signer).replenish(1, stable.address, epoch, maximum, deadline, gas)),
  ))
  const confirmed = attempts.filter(({ status }) => status === 'fulfilled')
  assert.equal(confirmed.length, 1, 'Only one concurrent purchase may consume the same allocation')
  const purchased = confirmed[0].value
  await treasuryBalance({ available: 440, allocated: 50, spent: 10 })
  await assert.rejects(ledger.callStatic.replenish(1, stable.address, epoch, maximum, (await now()) + 90))
  assert.equal((await ledger.rewardState(2, stable.address)).inventory.toString(), '0')
  assert.equal((await stable.balanceOf(ledger.address)).toString(), usdt(60).toString())

  await send(nft.mint(participant, 1))
  await at(start)
  await send(ledger.connect(user).join(1, 137, nft.address, 1, gas))
  await at(start + day)
  const key = await ledger.nftKey(137, nft.address, 1)
  const daily = await ledger.claimable(1, key, stable.address)
  assert.ok(daily.lte(usdt(10).div(365)) && daily.gt(0), 'Upfront purchases must not accelerate daily emissions')
  await at(end)
  await send(ledger.connect(user).recoverBudget(2))
  await treasuryBalance({ available: 490, allocated: 0, spent: 10, fundingReturned: 50 })
  await assert.rejects(ledger.callStatic.recoverExpiredRewards(1, stable.address))
  await at(end + 30 * day)
  await send(ledger.connect(user).recoverExpiredRewards(1, stable.address))
  await treasuryBalance({ available: 500, allocated: 0, rewardsReturned: 10 })
  assert.equal((await ledger.callStatic.recoverExpiredRewards(1, stable.address)).toString(), '0')
  assert.equal((await ledger.claimable(1, key, stable.address)).toString(), '0')
  assert.equal((await stable.balanceOf(vault.address)).toString(), usdt(500).toString())
  assert.equal((await stable.balanceOf(ledger.address)).toString(), '0')
  console.log('Consolidated same-asset purchase gas:', purchased.gasUsed.toString())
})

test('native POL deposits credit only exact WPOL and withdrawals cannot spend other balances', async () => {
  const amount = utils.parseEther('3')
  await send(vault.connect(owner).deposit(wrapped.address, amount, { value: amount }))
  assert.equal((await vault.balance(wrapped.address)).available.toString(), amount.toString())
  await assert.rejects(vault.connect(owner).callStatic.deposit(stable.address, amount, { value: amount }))
  await send(vault.connect(owner).withdraw(wrapped.address, amount))
  assert.equal((await wrapped.balanceOf(treasury)).toString(), amount.toString())
})
