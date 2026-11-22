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
  WBTC: '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6',
  WETH: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
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

const approvedRuntimes = {
  CoinCollect: ['0x62983b1c9e3c0cece7438c16cf954aac862ba329b7d57e0e6cb886edc75e7363',
    '0x2bc17223a99b6e2857796a5f64a1ed91067b5657', '0x693110e0dd495664e2e6bab84e8b7b5180d3fb2d7eeaf993214a9483c9c2f1ef'],
  QuickSwapV2: ['0xf1ce1bb9d7403281292baa290f5c56136484cc34395dc3666ad7f94c79f99b71',
    '0x5757371414417b8c6caad45baef941abc7d3ab32', '0x5b83bdbcc56b2e630f2807bbadd2b0c21619108066b92a58de081261089e9ce5'],
}

// Reserve floors mirror the reviewed fork policy in both directions.
const treasuryLegs = [
  ['CoinCollect', 'COLLECT', 'USDT', '100000', '100'],
  ['QuickSwapV2', 'WPOL', 'USDT', '50000', '10000'],
  ['QuickSwapV2', 'WPOL', 'SHIB', '5000', '10000000'],
  ['QuickSwapV2', 'WPOL', 'WBTC', '10000', '0.02'],
  ['CoinCollect', 'WPOL', 'COLLECT', '1000', '100000'],
  ['QuickSwapV2', 'WETH', 'USDT', '10', '10000'],
  ['QuickSwapV2', 'USDT', 'SHIB', '1', '100000'],
  ['QuickSwapV2', 'USDT', 'WBTC', '10', '0.0001'],
]
const treasuryPaths = [
  ['COLLECT', 'USDT', 'CoinCollect'],
  ['SHIB', 'USDT', 'QuickSwapV2', 'WPOL', 'QuickSwapV2'],
  ['COLLECT', 'WBTC', 'CoinCollect', 'WPOL', 'QuickSwapV2'],
  ['USDT', 'WBTC', 'QuickSwapV2', 'WPOL', 'QuickSwapV2'],
  ['SHIB', 'WPOL', 'QuickSwapV2'],
  ['WETH', 'USDT', 'QuickSwapV2'],
  ['USDT', 'WBTC', 'QuickSwapV2'],
  ['USDT', 'SHIB', 'QuickSwapV2'],
]
const Q112 = BigNumber.from(2).pow(112)
const WRAP256 = BigNumber.from(2).pow(256)
const WRAP32 = 2 ** 32

function cumulativeAt(cumulative, reserves, timestamp, input0) {
  const [reserveIn, reserveOut] = input0 ? [reserves[0], reserves[1]] : [reserves[1], reserves[0]]
  const lag = (timestamp % WRAP32 + WRAP32 - reserves[2]) % WRAP32
  return reserveIn.isZero() || reserveOut.isZero() ? cumulative
    : cumulative.add(reserveOut.mul(Q112).div(reserveIn).mul(lag)).mod(WRAP256)
}

async function observationBlock(provider, pinned) {
  const limit = pinned.timestamp - 1800
  let low = Math.max(0, pinned.number - 16_384)
  let high = pinned.number
  while (high - low > 1) {
    const middle = Math.floor((high + low) / 2)
    const block = await provider.getBlock(middle)
    if (block.timestamp <= limit) low = middle
    else high = middle
  }
  const block = await provider.getBlock(low)
  return block.timestamp <= limit ? block : null
}

async function inspectPolygonMarket(blockTag) {
  const url = process.env.COINCOLLECT_V3_POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com'
  const provider = new providers.StaticJsonRpcProvider({ url, timeout: 10_000 }, 137)
  if (await provider.send('eth_chainId', []) !== '0x89') throw new Error('Expected a Polygon read provider.')
  const pinned = await provider.getBlock(blockTag)
  if (!pinned) throw new Error('Requested Polygon block is unavailable.')
  const at = { blockTag: pinned.number }
  const prior = await observationBlock(provider, pinned).catch(() => null)
  const archive = new Map()
  const historicalPair = (pair, address) => {
    if (!prior) return null
    if (!archive.has(address)) {
      const before = { blockTag: prior.number }
      archive.set(address, Promise.all([
        pair.getReserves(before), pair.price0CumulativeLast(before), pair.price1CumulativeLast(before),
      ]).catch(() => null))
    }
    return archive.get(address)
  }
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
    const [reviewedRouter, reviewedFactory, reviewedPair] = approvedRuntimes[name]
    if (runtimeHash !== reviewedRouter || factoryAddress.toLowerCase() !== reviewedFactory) {
      throw new Error('Reviewed router runtime or factory identity changed.')
    }
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
      const input0 = token0.toLowerCase() === input
      const cap = reserveIn.mul(50).div(10_000)
      const earlier = await historicalPair(pair, pairAddress)
      const fixedPointSpot = reserveIn.isZero() ? null : reserveOut.mul(Q112).div(reserveIn)
      let twap = null
      if (earlier && !earlier[0][0].isZero() && !earlier[0][1].isZero()) {
        const current = cumulativeAt(input0 ? price0 : price1, reserves, pinned.timestamp, input0)
        const previous = cumulativeAt(earlier[input0 ? 1 : 2], earlier[0], prior.timestamp, input0)
        twap = current.add(WRAP256).sub(previous).mod(WRAP256).div(pinned.timestamp - prior.timestamp)
      }
      const deviation = twap && !twap.isZero() && fixedPointSpot
        ? fixedPointSpot.sub(twap).abs().mul(10_000) : null
      const driftBps = deviation ? deviation.div(twap).toNumber() : null
      const spotDeviationExceeded = deviation ? deviation.gt(twap.mul(100)) : null
      const policy = treasuryLegs.find(([routerName, x, y]) => routerName === name
        && ((x === funding && y === reward) || (x === reward && y === funding)))
      const [minIn, minOut] = !policy ? [] : policy[1] === funding ? policy.slice(3) : policy.slice(3).reverse()
      const reservePolicyMet = !policy || (reserveIn.gte(utils.parseUnits(minIn, assets[funding].decimals))
        && reserveOut.gte(utils.parseUnits(minOut, assets[reward].decimals)))
      const quote = async (amount) => (await instance.getAmountsOut(amount, [input, output], at))[1]
      return {
        router: name, funding, reward, status: 'PAIR', pair: pairAddress, pairCodeHash,
        reserveIn: utils.formatUnits(reserveIn, assets[funding].decimals),
        reserveOut: utils.formatUnits(reserveOut, assets[reward].decimals),
        maximumTradeAtModel50Bps: utils.formatUnits(cap, assets[funding].decimals),
        lastPairUpdateUnix: reserves[2],
        cumulativePrice: [price0.toString(), price1.toString()],
        reviewedPairBytecode: pairCodeHash === reviewedPair,
        reservePolicyMet, driftBps, spotDeviationExceeded,
        historicalTwapQ112: twap?.toString() ?? null,
        twap, cap, reserveInRaw: reserveIn, reserveOutRaw: reserveOut, quote,
      }
    }
    const pairs = []
    for (const funding of ['USDC', 'USDC.e', 'USDT', 'WPOL']) {
      for (const reward of ['COLLECT', 'WPOL', 'SHIB']) {
        if (funding !== reward) pairs.push([funding, reward])
      }
    }
    pairs.push(['WPOL', 'USDT'])
    for (const [routerName, x, y] of treasuryLegs) if (routerName === name) pairs.push([x, y], [y, x])
    const unique = [...new Map(pairs.map((pair) => [pair.join('/'), pair])).values()]

    await Promise.all(unique.map(async ([funding, reward]) => {
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
  const marketQuote = async (path, initial) => {
    let amount = initial
    let spot = initial
    let status = 'WITHIN_OBSERVED_MODEL'
    const diagnostics = []
    for (const key of path) {
      const leg = legs.get(key)
      if (!leg || leg.status !== 'PAIR' || leg.reserveInRaw.isZero() || leg.reserveOutRaw.isZero()) {
        return { status: 'NO_LIQUIDITY', diagnostics: [{ leg: key }] }
      }
      const problems = []
      if (!leg.reviewedPairBytecode) problems.push('PAIR_RUNTIME_UNREVIEWED')
      if (!leg.reservePolicyMet) problems.push('BELOW_RESERVE_FLOOR')
      if (amount.gt(leg.cap)) problems.push('OVER_50_BPS_INPUT_CAP')
      if (leg.driftBps === null) problems.push('ARCHIVE_TWAP_UNAVAILABLE')
      else if (leg.spotDeviationExceeded) problems.push('OVER_100_BPS_SPOT_TWAP_DEVIATION')
      const input = amount
      spot = spot.mul(leg.reserveOutRaw).div(leg.reserveInRaw)
      try {
        amount = await leg.quote(input)
      } catch (error) {
        if (error.code !== 'CALL_EXCEPTION') throw error
        return { status: 'QUOTE_REVERTED', diagnostics: [...diagnostics, { leg: key, problems }] }
      }
      if (!amount.isZero() && leg.twap) {
        const floor = input.mul(leg.twap).div(Q112).mul(9850).div(10_000)
        if (amount.lt(floor)) problems.push('BELOW_MODEL_TWAP_MINIMUM')
      }
      if (amount.isZero()) problems.push('ZERO_QUOTED_OUTPUT')
      if (problems.length) status = 'OUTSIDE_OR_MISSING_OBSERVED_MODEL'
      diagnostics.push({ leg: key, driftBps: leg.driftBps, problems })
    }
    return { status, diagnostics, quotedRaw: amount.toString(),
      spotGapBps: spot.isZero() ? null : spot.sub(amount).mul(10_000).div(spot).toNumber() }
  }
  const reference = {
    USDT: [],
    WPOL: ['QuickSwapV2/USDT/WPOL'],
    COLLECT: ['CoinCollect/USDT/COLLECT'],
    SHIB: ['QuickSwapV2/USDT/WPOL', 'QuickSwapV2/WPOL/SHIB'],
    WBTC: ['QuickSwapV2/USDT/WPOL', 'QuickSwapV2/WPOL/WBTC'],
    WETH: ['QuickSwapV2/USDT/WETH'],
  }
  const referenceUnits = {}
  for (const [symbol, path] of Object.entries(reference)) {
    // Reference conversion prices the input, without conferring any execution approval.
    const result = await marketQuote(path, utils.parseUnits('1', assets.USDT.decimals))
    referenceUnits[symbol] = result.quotedRaw ? BigNumber.from(result.quotedRaw) : null
  }
  const treasuryQuotes = []
  for (const [x, y, first, middle, last] of treasuryPaths) {
    for (const [from, to, a, b] of [[x, y, first, last], [y, x, last ?? first, first]]) {
      const path = middle ? [`${a}/${from}/${middle}`, `${b}/${middle}/${to}`] : [`${a}/${from}/${to}`]
      for (const size of [10, 100, 1000]) {
        const amount = referenceUnits[from]?.mul(size)
        const result = amount && !amount.isZero() ? await marketQuote(path, amount) : { status: 'INPUT_REFERENCE_UNAVAILABLE' }
        const gasModel = middle ? 710_000 : 490_000
        treasuryQuotes.push({
          from, to, path, usdtEquivalent: size,
          input: amount ? utils.formatUnits(amount, assets[from].decimals) : null,
          output: result.quotedRaw ? utils.formatUnits(result.quotedRaw, assets[to].decimals) : null,
          gasModel,
          feePOL: utils.formatEther(gasPrice.mul(gasModel)),
          feeUSDT: referencePrice ? utils.formatUnits(gasPrice.mul(gasModel).mul(referencePrice).div(utils.parseEther('1')), 6) : null,
          ...result,
        })
      }
    }
  }
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
      twap, cap, reserveInRaw, reserveOutRaw, quote, ...leg
    }]) => leg),
    publicTwapReference: prior ? { block: prior.number, hash: prior.hash, elapsed: pinned.timestamp - prior.timestamp } : null,
    liveAdapterApprovalAndTwap: 'BLOCKED_NO_PRODUCTION_V36_DEPLOYMENT',
    quotes, treasuryQuotes, operationCosts,
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
