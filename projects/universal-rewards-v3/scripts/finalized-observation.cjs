const { constants, utils } = require('ethers')

const IFACE = new utils.Interface([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
])

function blockFields(block) {
  if (!block || !utils.isHexString(block.hash, 32) || !utils.isHexString(block.number) || !utils.isHexString(block.timestamp)) {
    throw new Error('A valid finalized source block is required.')
  }
  return { number: BigInt(block.number), hash: block.hash.toLowerCase(), timestamp: Number(block.timestamp) }
}

function readProvider(url) {
  const endpoint = new URL(url)
  if (endpoint.protocol !== 'https:') throw new Error('A witness must use an HTTPS source RPC.')
  return {
    id: endpoint.hostname,
    async request(method, params) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) throw new Error('A witness source RPC is unavailable.')
      const payload = await response.json()
      if (payload.error) throw new Error('A witness source RPC rejected the finalized block request.')
      return payload.result
    },
  }
}

/**
 * Produces unsigned evidence for a witness to review and sign independently. This is used only
 * with the isolated ownership verifier. The settlement contract still requires a signer quorum.
 */
async function collectFinalizedOwnership({
  sourceChainId, collection: address, tokenId, issuedAt, minimumSourceAge, maximumSourceAge, clients,
}) {
  if (!Number.isSafeInteger(sourceChainId) || sourceChainId <= 0 || [137, 31337].includes(sourceChainId) ||
    clients.length < 2 || clients.length > 5 || new Set(clients.map(({ id }) => id.toLowerCase())).size !== clients.length ||
    !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(minimumSourceAge) ||
    !Number.isSafeInteger(maximumSourceAge) || minimumSourceAge <= 0 || maximumSourceAge > 86400 ||
    minimumSourceAge >= maximumSourceAge) throw new Error('The witness source policy is invalid.')

  const collection = utils.getAddress(address)
  if (collection === constants.AddressZero) throw new Error('The collection address is invalid.')
  const latest = await Promise.all(clients.map(async ({ request }) => {
    if (BigInt(await request('eth_chainId', [])) !== BigInt(sourceChainId)) throw new Error('Source RPC chain ID mismatch.')
    return blockFields(await request('eth_getBlockByNumber', ['finalized', false]))
  }))
  const commonHeight = latest.reduce((lowest, block) => block.number < lowest ? block.number : lowest, latest[0].number)
  const commonTag = '0x' + commonHeight.toString(16)
  const blocks = await Promise.all(clients.map(({ request }) => request('eth_getBlockByNumber', [commonTag, false]).then(blockFields)))
  const block = blocks[0]
  if (commonHeight <= 0n || blocks.some((candidate) =>
    candidate.number !== commonHeight || candidate.hash !== block.hash || candidate.timestamp !== block.timestamp)) {
    throw new Error('Source RPCs disagree on the finalized block.')
  }

  const age = issuedAt - block.timestamp
  const validUntil = Math.min(issuedAt + 1200, block.timestamp + maximumSourceAge)
  if (age < minimumSourceAge || validUntil <= issuedAt) throw new Error('The finalized source block is outside the freshness policy.')
  const canonical = { blockHash: block.hash, requireCanonical: true }
  const owners = await Promise.all(clients.map(async ({ request }) => {
    const [capability, result] = await Promise.all([
      request('eth_call', [{ to: collection, data: IFACE.encodeFunctionData('supportsInterface', ['0x80ac58cd']) }, canonical]),
      request('eth_call', [{ to: collection, data: IFACE.encodeFunctionData('ownerOf', [tokenId]) }, canonical]),
    ])
    if (capability !== constants.HashZero.slice(0, -1) + '1' || !utils.isHexString(result, 32) ||
      !result.toLowerCase().startsWith('0x' + '00'.repeat(12))) {
      throw new Error('The source collection did not supply a valid ERC-721 owner.')
    }
    return utils.getAddress('0x' + result.slice(-40))
  }))
  const owner = owners[0]
  if (owner === constants.AddressZero || owners.some((claimed) => claimed !== owner)) {
    throw new Error('Source RPCs did not agree on a live NFT owner.')
  }
  return {
    sourceChainId, collection, tokenId: String(tokenId), owner, sourceBlock: commonHeight.toString(),
    sourceBlockHash: block.hash, sourceTimestamp: block.timestamp, issuedAt, validUntil,
  }
}

module.exports = { readProvider, collectFinalizedOwnership }
