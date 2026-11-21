const { BigNumber, Contract, providers, utils, constants } = require('ethers')

const QUICKSWAP_ROUTER = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'
const POLYGON_ROUTER = '0xCc2a5477978A23282b80a66aAa2903b71f702040'
const POLYGON_ASSETS = {
  USDC: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  'USDC.e': '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
  USDT: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  WPOL: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
  COLLECT: '0x56633733fc8baf9f730ad2b6b9956ae22c6d4148',
  SHIB: '0x6f8a06447ff6fcf75d803135a7de15ce88c1d4ec',
}

const routerAbi = [
  'function factory() view returns (address)',
  'function WETH() view returns (address)',
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
]
const pairAbi = [
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function price0CumulativeLast() view returns (uint256)',
  'function price1CumulativeLast() view returns (uint256)',
  'function getReserves() view returns (uint112,uint112,uint32)',
]

async function inspectPolygonMarket(blockTag) {
  const url = process.env.COINCOLLECT_V3_POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com'
  const provider = new providers.StaticJsonRpcProvider({ url, timeout: 10_000 }, 137)
  if (await provider.send('eth_chainId', []) !== '0x89') throw new Error('Expected a Polygon read provider.')
  const pinned = await provider.getBlock(blockTag)
  if (!pinned) throw new Error('Requested Polygon block is unavailable.')
  const at = { blockTag: pinned.number }
  const codeHash = async (address) => {
    const code = await provider.getCode(address, pinned.number)
    if (code === '0x') throw new Error('Expected contract runtime at ' + address)
    return utils.keccak256(code)
  }

  const roles = ['owner', 'admin', 'implementation', 'proxyOwner', 'proxyAdmin', 'masterMinter',
    'pauser', 'blacklister', 'upgrader', 'getOwner', 'feeToSetter', 'feeTo']
  const inspectRoles = async (address) => {
    const contract = new Contract(address, roles.map((name) => 'function ' + name + '() view returns (address)'), provider)
    const entries = await Promise.all(roles.map(async (name) => {
      try {
        return [name, await contract[name](at)]
      } catch (error) {
        if (error.code !== 'CALL_EXCEPTION') throw error
        return null
      }
    }))
    return Object.fromEntries(entries.filter(Boolean))
  }
  const slotAddress = async (address, label, subtract) => {
    const slot = BigNumber.from(utils.id(label)).sub(subtract).toHexString()
    const value = await provider.getStorageAt(address, slot, pinned.number)
    return /^0x0{24}[0-9a-f]{40}$/i.test(value) && BigNumber.from(value).gt(0)
      ? utils.getAddress('0x' + value.slice(-40))
      : null
  }

  const assets = {}
  await Promise.all(Object.entries(POLYGON_ASSETS).map(async ([symbol, address]) => {
    const erc20 = new Contract(address, ['function decimals() view returns (uint8)'], provider)
    const [decimals, runtimeHash, visibleRoles, implementation1967, admin1967, beacon, legacyImplementation, legacyAdmin] =
      await Promise.all([
        erc20.decimals(at), codeHash(address), inspectRoles(address),
        slotAddress(address, 'eip1967.proxy.implementation', 1),
        slotAddress(address, 'eip1967.proxy.admin', 1),
        slotAddress(address, 'eip1967.proxy.beacon', 1),
        slotAddress(address, 'org.zeppelinos.proxy.implementation', 0),
        slotAddress(address, 'org.zeppelinos.proxy.admin', 0),
      ])
    const candidates = [implementation1967, legacyImplementation, visibleRoles.implementation].filter(
      (candidate) => candidate && candidate !== constants.AddressZero,
    )
    const implementation = candidates[0] ?? null
    assets[symbol] = {
      address, decimals, runtimeHash, visibleRoles, implementation, implementation1967,
      legacyImplementation, admin1967, legacyAdmin, beacon,
      implementationRuntimeHash: implementation ? await codeHash(implementation) : null,
      implementationEvidence: implementation ? 'DISCOVERED' : 'UNKNOWN_IF_CUSTOM_PROXY',
    }
  }))

  const routers = {}
  const legs = new Map()
  for (const [name, address] of Object.entries({ CoinCollect: POLYGON_ROUTER, QuickSwapV2: QUICKSWAP_ROUTER })) {
    const instance = new Contract(address, routerAbi, provider)
    const [factoryAddress, wrappedNative, runtimeHash] = await Promise.all([
      instance.factory(at), instance.WETH(at), codeHash(address),
    ])
    if (wrappedNative.toLowerCase() !== POLYGON_ASSETS.WPOL) throw new Error('Router identity mismatch.')
    const [factoryRuntimeHash, factoryRoles] = await Promise.all([codeHash(factoryAddress), inspectRoles(factoryAddress)])
    routers[name] = { address, runtimeHash, factoryAddress, factoryRuntimeHash, factoryRoles, wrappedNative }
    const factory = new Contract(factoryAddress, ['function getPair(address,address) view returns (address)'], provider)
    const leg = async (funding, reward) => {
      const input = assets[funding].address
      const output = assets[reward].address
      const pairAddress = await factory.getPair(input, output, at)
      if (pairAddress === constants.AddressZero) return { router: name, funding, reward, status: 'NO_PAIR' }

      const pair = new Contract(pairAddress, pairAbi, provider)
      const [actualFactory, token0, token1, reserves, pairCodeHash, price0, price1] = await Promise.all([
        pair.factory(at), pair.token0(at), pair.token1(at), pair.getReserves(at), codeHash(pairAddress),
        pair.price0CumulativeLast(at), pair.price1CumulativeLast(at),
      ])
      if (actualFactory !== factoryAddress || ![token0, token1].map((token) => token.toLowerCase()).includes(input)
        || ![token0, token1].map((token) => token.toLowerCase()).includes(output)) throw new Error('Pair identity mismatch.')
      const [reserveIn, reserveOut] = token0.toLowerCase() === input ? [reserves[0], reserves[1]] : [reserves[1], reserves[0]]
      const cap = reserveIn.mul(50).div(10_000)
      const quote = async (amount) => (await instance.getAmountsOut(amount, [input, output], at))[1]
      return {
        router: name, funding, reward, status: 'PAIR', pair: pairAddress, pairCodeHash,
        reserveIn: utils.formatUnits(reserveIn, assets[funding].decimals),
        reserveOut: utils.formatUnits(reserveOut, assets[reward].decimals),
        maximumTradeAtModel50Bps: utils.formatUnits(cap, assets[funding].decimals),
        lastPairUpdateUnix: reserves[2],
        cumulativePrice: [price0.toString(), price1.toString()],
        cap, reserveInRaw: reserveIn, reserveOutRaw: reserveOut, quote,
      }
    }
    const pairs = []
    for (const funding of ['USDC', 'USDC.e', 'USDT', 'WPOL']) {
      for (const reward of ['COLLECT', 'WPOL', 'SHIB']) {
        if (funding !== reward) pairs.push([funding, reward])
      }
    }
    pairs.push(['WPOL', 'USDT'])
    await Promise.all(pairs.map(async ([funding, reward]) => {
      legs.set([name, funding, reward].join('/'), await leg(funding, reward))
    }))
  }

  const paths = [
    ['Direct CoinCollect COLLECT', ['CoinCollect/USDT/COLLECT']],
    ['QuickSwap WPOL', ['QuickSwapV2/USDT/WPOL']],
    ['Via WPOL to COLLECT', ['QuickSwapV2/USDT/WPOL', 'CoinCollect/WPOL/COLLECT']],
    ['Direct QuickSwap SHIB', ['QuickSwapV2/USDT/SHIB']],
    ['Via WPOL to SHIB', ['QuickSwapV2/USDT/WPOL', 'QuickSwapV2/WPOL/SHIB']],
  ]
  const quotes = []
  for (const [route, path] of paths) {
    const routeLegs = path.map((key) => legs.get(key))
    const reward = routeLegs.at(-1).reward
    for (const budget of [10, 100, 1000]) {
      const allocationBps = { COLLECT: 5000, WPOL: 3000, SHIB: 2000 }[reward]
      for (const [scenario, share] of [['single', 10_000], ['basket', allocationBps]]) {
        const input = utils.parseUnits(String(budget), assets.USDT.decimals).mul(share).div(10_000)
        const row = { route, budget, scenario, input: utils.formatUnits(input, assets.USDT.decimals), reward }
        let current = input
        let spot = input
        let exceedsCap = false
        for (const leg of routeLegs) {
          if (leg.status !== 'PAIR' || leg.reserveInRaw.isZero() || leg.reserveOutRaw.isZero()) {
            current = null
            row.status = 'NO_LIQUIDITY'
            break
          }
          exceedsCap ||= current.gt(leg.cap)
          spot = spot.mul(leg.reserveOutRaw).div(leg.reserveInRaw)
          try {
            current = await leg.quote(current)
          } catch (error) {
            if (error.code !== 'CALL_EXCEPTION') throw error
            current = null
            row.status = 'QUOTE_REVERTED'
            break
          }
        }
        if (current) {
          row.status = exceedsCap ? 'OVER_MODEL_RESERVE_CAP' : 'WITHIN_MODEL_RESERVE_CAP'
          row.quoted = utils.formatUnits(current, assets[reward].decimals)
          row.spotGapBps = spot.isZero() ? null : spot.sub(current).mul(10_000).div(spot).toNumber()
        }
        quotes.push(row)
      }
    }
  }

  const gasPrice = await provider.getGasPrice()
  const nativeLeg = legs.get('QuickSwapV2/WPOL/USDT')
  const referencePrice = nativeLeg.status === 'PAIR'
    ? await nativeLeg.quote(utils.parseEther('1'))
    : null
  const operationCosts = Object.fromEntries(Object.entries({
    joinAndHarvest: 821325, threePurchasesAndObservations: 2322873, thirteenWindows: 30197349,
  }).map(([name, gas]) => {
    const fee = gasPrice.mul(gas)
    return [name, {
      gas,
      pol: utils.formatEther(fee),
      usdtAtOnePolQuote: referencePrice
        ? utils.formatUnits(fee.mul(referencePrice).div(utils.parseEther('1')), assets.USDT.decimals)
        : null,
    }]
  }))
  return {
    chainId: 137,
    number: pinned.number, blockHash: pinned.hash, timestamp: new Date(pinned.timestamp * 1000).toISOString(),
    latestGasPriceGweiAtRead: utils.formatUnits(gasPrice, 'gwei'),
    onePolQuoteUsdt: referencePrice ? utils.formatUnits(referencePrice, assets.USDT.decimals) : null,
    assets, routers,
    pairs: [...legs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, {
      cap, reserveInRaw, reserveOutRaw, quote, ...leg
    }]) => leg),
    quotes, operationCosts,
  }
}

if (require.main === module) {
  const block = process.argv[2] ? Number(process.argv[2]) : 'latest'
  inspectPolygonMarket(block).then((market) => {
    console.log(JSON.stringify(market, null, 2))
  }).catch((error) => {
    // Ethers request errors can include credentials from a configured RPC URL.
    console.error('Polygon market read failed: ' + (error.code || error.name))
    process.exitCode = 1
  })
}

module.exports = { inspectPolygonMarket, POLYGON_ROUTER, POLYGON_ASSETS, routerAbi, pairAbi }
