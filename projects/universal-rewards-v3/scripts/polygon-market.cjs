const { Contract, providers, utils, constants } = require('ethers')

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
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
]

async function inspectPolygonMarket(blockTag) {
  const url = process.env.COINCOLLECT_V3_POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com'
  const provider = new providers.StaticJsonRpcProvider({ url, timeout: 10_000 }, 137)
  if (await provider.send('eth_chainId', []) !== '0x89') throw new Error('Expected a Polygon read provider.')
  const pinned = await provider.getBlock(blockTag)
  if (!pinned) throw new Error('Requested Polygon block is unavailable.')
  const at = { blockTag: pinned.number }
  const router = new Contract(POLYGON_ROUTER, routerAbi, provider)
  const [factoryAddress, wrappedNative, code] = await Promise.all([
    router.factory(at),
    router.WETH(at),
    provider.getCode(POLYGON_ROUTER, pinned.number),
  ])
  if (wrappedNative.toLowerCase() !== POLYGON_ASSETS.WPOL || code === '0x') throw new Error('Router identity mismatch.')
  const factory = new Contract(factoryAddress, ['function getPair(address,address) view returns (address)'], provider)
  const reference = { number: pinned.number, blockHash: pinned.hash, router: POLYGON_ROUTER, routerCodeHash: utils.keccak256(code), factory: factoryAddress, wrappedNative }

  const decimals = new Map()
  for (const [symbol, address] of Object.entries(POLYGON_ASSETS)) {
    const asset = new Contract(address, ['function decimals() view returns (uint8)'], provider)
    decimals.set(symbol, await asset.decimals(at))
  }
  const routes = []
  for (const funding of ['USDC', 'USDC.e', 'USDT', 'WPOL']) {
    for (const reward of ['COLLECT', 'WPOL', 'SHIB']) {
      if (funding === reward) continue
      const input = POLYGON_ASSETS[funding]
      const output = POLYGON_ASSETS[reward]
      const pairAddress = await factory.getPair(input, output, at)
      if (pairAddress === constants.AddressZero) {
        routes.push({ funding, reward, status: 'NO_PAIR' })
        continue
      }

      const pair = new Contract(pairAddress, pairAbi, provider)
      const [token0, reserves, pairCode] = await Promise.all([
        pair.token0(at),
        pair.getReserves(at),
        provider.getCode(pairAddress, pinned.number),
      ])
      const [inReserve, outReserve] = token0.toLowerCase() === input ? reserves : [reserves[1], reserves[0]]
      const maximumTradeSize = inReserve.mul(50).div(10_000)
      routes.push({
        funding,
        reward,
        pair: pairAddress,
        pairCodeHash: utils.keccak256(pairCode),
        reserveIn: utils.formatUnits(inReserve, decimals.get(funding)),
        reserveOut: utils.formatUnits(outReserve, decimals.get(reward)),
        maximumTradeFromReserveAlone: utils.formatUnits(maximumTradeSize, decimals.get(funding)),
      })
    }
  }
  return { ...reference, routes }
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
