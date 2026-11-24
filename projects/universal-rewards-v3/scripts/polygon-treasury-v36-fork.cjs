const assert = require('node:assert/strict')
const fs = require('node:fs')
const { test } = require('node:test')
const { Contract, ContractFactory, constants, utils } = require('ethers')
const { compileV36 } = require('./compile-v36.cjs')
const { compileV310 } = require('./compile-v310.cjs')
const { recordDeployment } = require('./build-release.cjs')
const { linkBytecode } = require('./link-bytecode.cjs')
const { startLocalAnvil } = require('./local-anvil.cjs')
const { POLYGON_ASSETS, POLYGON_ROUTER, routerAbi } = require('./polygon-market.cjs')
const { deployV36Core, reviewAndApprove, hash, send } = require('./v36-fixture.cjs')

const BLOCK = 97638790
const BLOCK_HASH = '0x9cf4791f6b4aab715d03aa5f66ad39e40676b80f00620927c6ddc6827db63419'
const QUICK = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'
const ROUTERS = [
  [QUICK, '0xf1ce1bb9d7403281292baa290f5c56136484cc34395dc3666ad7f94c79f99b71', '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32'],
  [POLYGON_ROUTER, '0x62983b1c9e3c0cece7438c16cf954aac862ba329b7d57e0e6cb886edc75e7363', '0x2bc17223A99B6e2857796a5F64A1ED91067b5657'],
]
const PAIR_HASHES = [
  '0x5b83bdbcc56b2e630f2807bbadd2b0c21619108066b92a58de081261089e9ce5',
  '0x693110e0dd495664e2e6bab84e8b7b5180d3fb2d7eeaf993214a9483c9c2f1ef',
]
const zero = constants.AddressZero
const gas = { gasLimit: 8_000_000 }
const tokens = {
  ...POLYGON_ASSETS,
  WBTC: '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6',
  WETH: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
}
const decimals = { WPOL: 18, USDT: 6, WBTC: 8, WETH: 18, SHIB: 18, COLLECT: 18 }
const implementations = {
  USDT: '0x90040487A6C9F949C4F07CaDCFB0f3B8EEAb4229',
  SHIB: '0x0ED3D66Dd0c9be71C8bf280A010B96881C69e7B6',
  WBTC: '0x7FFB3d637014488b63fb9858E279385685AFc1e2',
}
const toUnits = (symbol, amount) => utils.parseUnits(String(amount), decimals[symbol])

const instant = process.env.COINCOLLECT_V310_FIXTURE === '1'
test(`V${instant ? '3.10' : '3.6.1'} pinned Polygon Treasury swaps use the reviewed direct and two-leg paths in both directions`, async (t) => {
  const upstream = process.env.COINCOLLECT_V3_POLYGON_RPC || 'https://polygon.gateway.tenderly.co'
  assert.equal(new URL(upstream).protocol, 'https:')
  const fork = await startLocalAnvil(['--fork-url', upstream, '--fork-block-number', String(BLOCK)])
  t.after(fork.close)
  const { provider } = fork
  assert.equal(await provider.send('eth_chainId', []), '0x7a69')
  assert.equal((await provider.getBlock(BLOCK)).hash, BLOCK_HASH)
  const [operator] = await provider.listAccounts()
  const signer = provider.getSigner(operator)
  const output = instant ? compileV310() : compileV36()
  const links = {}
  const deployments = []
  const deploy = async (name, file, ...args) => {
    const artifact = output[file][name]
    const instance = await (await new ContractFactory(artifact.abi, linkBytecode(artifact, links), signer).deploy(...args, gas)).deployed()
    const observed = await provider.getCode(instance.address)
    const runtime = recordDeployment(artifact, links, observed, instance.address)
    links[file + ':' + name] = instance.address
    deployments.push({ name, file, address: instance.address, args, ...runtime })
    return instance
  }
  const { registry, planner, vault, ledger } = await deployV36Core(deploy, operator, tokens.WPOL, instant)
  await send(ledger.attachTreasuryVault(vault.address))
  const ERC20 = [
    'function approve(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)',
    'function allowance(address,address) view returns(uint256)', 'function decimals() view returns(uint8)',
    'function deposit() payable', 'function implementation() view returns(address)',
  ]
  const assets = Object.fromEntries(Object.keys(decimals).map((symbol) => [symbol, new Contract(tokens[symbol], ERC20, signer)]))
  const router = (address) => new Contract(address, [
    ...routerAbi, 'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns(uint256[])',
  ], signer)
  const latest = async () => (await provider.getBlock('latest')).timestamp
  await send(assets.WPOL.deposit({ value: toUnits('WPOL', 800) }))
  for (const [symbol, routerAddress] of [
    ['USDT', QUICK], ['WBTC', QUICK], ['WETH', QUICK], ['SHIB', QUICK], ['COLLECT', POLYGON_ROUTER],
  ]) {
    const budget = toUnits('WPOL', 100)
    const dex = router(routerAddress)
    const path = [tokens.WPOL, tokens[symbol]]
    const quote = (await dex.getAmountsOut(budget, path))[1]
    await send(assets.WPOL.approve(routerAddress, budget))
    await send(dex.swapExactTokensForTokens(budget, quote.mul(99).div(100), path, operator, await latest() + 100, gas))
  }
  const assetEvidence = []
  for (const [symbol, asset] of Object.entries(assets)) {
    assert.equal(await asset.decimals(), decimals[symbol])
    if (implementations[symbol]) assert.equal(await asset.implementation(), implementations[symbol])
    await reviewAndApprove(registry, asset, provider, decimals[symbol], 7, implementations[symbol])
    await send(planner.setAsset(asset.address, true))
    const available = await asset.balanceOf(operator)
    await send(asset.approve(vault.address, available))
    await send(vault.deposit(asset.address, available))
    assetEvidence.push({ symbol, address: asset.address, decimals: decimals[symbol],
      runtimeKeccak256: await hash(provider, asset.address), implementation: implementations[symbol] ?? null })
  }

  const adapters = []
  for (const [dex, runtimeHash, factory] of ROUTERS) {
    assert.equal(await hash(provider, dex), runtimeHash)
    const adapter = await deploy('RewardSwapAdapter', 'contracts/RewardSwapAdapter.sol', operator, dex, runtimeHash, factory, tokens.WPOL)
    await send(planner.setAdapter(adapter.address, await hash(provider, adapter.address)))
    adapters.push(adapter)
  }
  const legs = [
    [1, 'COLLECT', 'USDT', '0x0cCc84b6506003487AEC687085e82C2f912E607B', '100000', '100'],
    [0, 'WPOL', 'USDT', '0x604229c960e5CACF2aaEAc8Be68Ac07BA9dF81c3', '50000', '10000'],
    [0, 'WPOL', 'SHIB', '0x5FB641De2663e8a94C9dea0a539817850d996e99', '5000', '10000000'],
    [0, 'WPOL', 'WBTC', '0xf6B87181BF250af082272E3f448eC3238746Ce3D', '10000', '0.02'],
    [1, 'WPOL', 'COLLECT', '0xFb09801B10298dB9663D2790F5D5Bc6aFa354497', '1000', '100000'],
    [0, 'WETH', 'USDT', '0xF6422B997c7F54D1c6a6e103bcb1499EeA0a7046', '10', '10000'],
  ]
  const activeLegs = []
  for (const [dex, x, y, pair, minX, minY] of legs) {
    assert.equal(await hash(provider, pair), PAIR_HASHES[dex])
    for (const [from, to, minimumIn, minimumOut] of [[x, y, minX, minY], [y, x, minY, minX]]) {
      await send(adapters[dex].configureRoute(tokens[from], tokens[to], pair, PAIR_HASHES[dex],
        toUnits(from, minimumIn), toUnits(to, minimumOut)))
      activeLegs.push([dex, from, to])
    }
  }
  const paths = [
    ['COLLECT', 'USDT', 1, null, 1],
    ['SHIB', 'USDT', 0, 'WPOL', 0],
    ['COLLECT', 'WBTC', 1, 'WPOL', 0],
    ['USDT', 'WBTC', 0, 'WPOL', 0],
    ['SHIB', 'WPOL', 0, null, 0],
    ['WETH', 'USDT', 0, null, 0],
  ]
  for (const [x, y, first, middle, last] of paths) {
    for (const [from, to, a, b] of [[x, y, first, last], [y, x, last, first]]) {
      await send(planner.configurePath(tokens[from], tokens[to], 0, [
        adapters[a].address, middle ? tokens[middle] : zero, middle ? adapters[b].address : zero, true,
      ]))
    }
  }
  await assert.rejects(vault.quoteTreasurySwap(tokens.USDT, tokens.WBTC, toUnits('USDT', 1)), {
    data: utils.id('NoApprovedRoute()').slice(0, 10),
  })
  const observations = []
  for (let sample = 0; sample < 2; sample++) {
    if (sample) await provider.send('evm_increaseTime', [1805])
    for (const [dex, from, to] of activeLegs) {
      const receipt = await send(adapters[dex].observe(tokens[from], tokens[to]))
      observations.push(receipt.gasUsed.toNumber())
    }
  }
  // Fits the vault balance but exceeds the CoinCollect pair's cap.
  await assert.rejects(vault.quoteTreasurySwap(tokens.USDT, tokens.COLLECT, toUnits('USDT', 4)))
  const saleSize = { COLLECT: '100', USDT: '0.5', WBTC: '0.00001', WETH: '0.0005', WPOL: '1', SHIB: '10000' }
  const receipts = []
  for (const [x, y, , intermediate] of paths) {
    for (const [from, to] of [[x, y], [y, x]]) {
      const amount = toUnits(from, saleSize[from])
      const [route, , minimum] = await vault.quoteTreasurySwap(tokens[from], tokens[to], amount)
      const beforeInput = await assets[from].balanceOf(vault.address)
      const beforeOutput = await assets[to].balanceOf(vault.address)
      const receipt = await send(vault.swapTreasury(tokens[from], tokens[to], route, amount, minimum, await latest() + 120, gas))
      const event = receipt.events.find(({ event: name }) => name === 'TreasurySwap').args
      assert.ok(event.amountOut.gte(minimum))
      assert.equal((await assets[from].balanceOf(vault.address)).toString(), beforeInput.sub(amount).toString())
      assert.equal((await assets[to].balanceOf(vault.address)).toString(), beforeOutput.add(event.amountOut).toString())
      assert.equal((await vault.balance(tokens[to])).available.toString(), beforeOutput.add(event.amountOut).toString())
      assert.ok((await assets[from].allowance(vault.address, planner.address)).isZero())
      receipts.push({ from, to, intermediate, input: amount.toString(), received: event.amountOut.toString(),
        transaction: receipt.transactionHash, gasUsed: receipt.gasUsed.toNumber() })
      t.diagnostic(`${from} → ${to}${intermediate ? ' via ' + intermediate : ''}, ${receipt.gasUsed} gas`)
    }
  }
  if (process.env.COINCOLLECT_V36_FORK_MANIFEST) {
    fs.writeFileSync(process.env.COINCOLLECT_V36_FORK_MANIFEST,
      JSON.stringify({ sourceChain: 137, chain: 31337, block: BLOCK, blockHash: BLOCK_HASH, deployments,
        assets: assetEvidence, routerInputs: ROUTERS, pairInputs: legs, swaps: receipts, observationGas: observations }, null, 2) + '\n')
  }
})
