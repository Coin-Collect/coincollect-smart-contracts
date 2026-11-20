const { utils } = require('ethers')

const sourceAbi = new utils.Interface([
  'event Observation(uint64 indexed sequence,uint8 action,uint256 indexed poolId,uint256 indexed tokenId,address from,address to,uint128 amount,uint128 balance,uint64 occurredAt)',
  'function sequence() view returns (uint64)',
  'function collection() view returns (address)',
  'function settlementLedger() view returns (address)',
  'function standard() view returns (uint16)',
  'function rewardsHook() view returns (address)',
  'function supportsInterface(bytes4) view returns (bool)',
])
const entryType = 'tuple(uint8 action,uint256 poolId,uint256 tokenId,address from,address to,uint128 amount,uint128 balance,uint64 occurredAt)[]'
const types = { JournalBatch: [
  { name: 'adapter', type: 'address' }, { name: 'sourceJournal', type: 'address' }, { name: 'chain', type: 'uint256' },
  { name: 'collection', type: 'address' }, { name: 'first', type: 'uint64' }, { name: 'sourceBlock', type: 'uint64' },
  { name: 'sourceHash', type: 'bytes32' }, { name: 'finalizedAt', type: 'uint64' }, { name: 'sourceSequence', type: 'uint64' }, { name: 'entriesHash', type: 'bytes32' },
] }

function hex(number) {
  return utils.hexValue(number)
}

function canonicalBlock(block) {
  if (!block || !utils.isHexString(block.hash, 32) || !utils.isHexString(block.number) || !utils.isHexString(block.timestamp)) {
    throw Error('Invalid finalized block.')
  }
  return { number: BigInt(block.number), hash: block.hash.toLowerCase(), time: Number(block.timestamp) }
}

async function collectFinalizedJournal({
  chain, collection, standard, sourceJournal, settlementLedger, sourceRuntimeHash, collectionRuntimeHash,
  adapter, verifier, first, fromBlock, previous, now, clients,
}) {
  if (![8453, 42161].includes(chain) || ![721, 1155].includes(standard) || clients.length < 2 || clients.length > 5 ||
      new Set(clients.map((client) => client.id.toLowerCase())).size !== clients.length ||
      !utils.isHexString(sourceRuntimeHash, 32) || !utils.isHexString(collectionRuntimeHash, 32)) throw Error('Invalid journal policy.')
  if (BigInt(first) < 1n || BigInt(fromBlock) < 0n || !Number.isSafeInteger(now)) throw Error('Invalid journal cursor.')
  const heads = await Promise.all(clients.map(async ({ request }) => {
    if (Number(await request('eth_chainId', [])) !== chain) throw Error('Wrong source chain.')
    return canonicalBlock(await request('eth_getBlockByNumber', ['finalized', false]))
  }))
  const height = heads.reduce((minimum, { number }) => number < minimum ? number : minimum, heads[0].number)
  const observations = await Promise.all(clients.map(async ({ request }) => {
    const head = canonicalBlock(await request('eth_getBlockByNumber', [hex(height), false]))
    if (head.number !== height || now < head.time || now - head.time >= 7200) throw Error('Stale finalized source.')
    if (previous) {
      if (BigInt(previous.sourceBlock) > height) throw Error('Finalized source is behind the settlement cursor.')
      const prior = canonicalBlock(await request('eth_getBlockByNumber', [hex(previous.sourceBlock), false]))
      if (prior.hash !== previous.sourceHash.toLowerCase()) throw Error('Finalized source disagrees with the settlement cursor.')
    }
    const canonical = { blockHash: head.hash, requireCanonical: true }
    const call = async (name, contract = sourceJournal, args = []) => {
      const output = await request('eth_call', [{ to: contract, data: sourceAbi.encodeFunctionData(name, args) }, canonical])
      return sourceAbi.decodeFunctionResult(name, output)[0]
    }
    const [journalCode, nftCode, actualCollection, actualLedger, actualStandard, hook, supports, count] = await Promise.all([
      request('eth_getCode', [sourceJournal, canonical]), request('eth_getCode', [collection, canonical]),
      call('collection'), call('settlementLedger'), call('standard'), call('rewardsHook', collection),
      call('supportsInterface', collection, [standard === 1155 ? '0xd9b67a26' : '0x80ac58cd']), call('sequence'),
    ])
    if (utils.keccak256(journalCode) !== sourceRuntimeHash || utils.keccak256(nftCode) !== collectionRuntimeHash ||
        actualCollection !== utils.getAddress(collection) || actualLedger !== utils.getAddress(settlementLedger) ||
        actualStandard !== standard || hook !== utils.getAddress(sourceJournal) || !supports) throw Error('Unreviewed source contracts.')
    const end = BigInt(fromBlock) + 2047n
    const upper = end < height ? end : height
    const logs = upper < BigInt(fromBlock) ? [] : await request('eth_getLogs', [{
      address: sourceJournal, fromBlock: hex(fromBlock), toBlock: hex(upper),
      topics: [sourceAbi.getEventTopic('Observation'),
        Array.from({ length: 32 }, (_, index) => utils.hexZeroPad(hex(BigInt(first) + BigInt(index)), 32))],
    }])
    if (!Array.isArray(logs)) throw Error('Invalid source journal log response.')
    const relevant = logs.map((log) => ({ log, args: sourceAbi.parseLog(log).args }))
      .filter(({ args }) => BigInt(args.sequence.toString()) >= BigInt(first)).slice(0, 32)
    const blocks = new Map()
    const entries = []
    for (const { log, args } of relevant) {
      if (log.removed || utils.getAddress(log.address) !== utils.getAddress(sourceJournal) ||
          BigInt(log.blockNumber) > upper || BigInt(log.blockNumber) < BigInt(fromBlock) ||
          BigInt(args.sequence.toString()) !== BigInt(first) + BigInt(entries.length)) throw Error('Journal sequence gap.')
      if (!blocks.has(log.blockNumber)) {
        blocks.set(log.blockNumber, canonicalBlock(await request('eth_getBlockByNumber', [log.blockNumber, false])))
      }
      const occurrence = blocks.get(log.blockNumber)
      if (occurrence.hash !== log.blockHash.toLowerCase() || occurrence.time !== Number(args.occurredAt)) {
        throw Error('Journal evidence is outside the canonical source chain.')
      }
      entries.push([args.action, args.poolId.toString(), args.tokenId.toString(), args.from, args.to,
        args.amount.toString(), args.balance.toString(), args.occurredAt.toString()])
    }
    if (upper === height && entries.length < 32 && BigInt(count.toString()) >= BigInt(first) + BigInt(entries.length)) {
      throw Error('Source RPC omitted journal entries.')
    }
    const sourceSequence = count.toString();
    if (BigInt(first) - 1n + BigInt(entries.length) > BigInt(sourceSequence)) throw Error('Invalid finalized journal length.');
    return { sourceBlock: height.toString(), sourceHash: head.hash, finalizedAt: head.time, sourceSequence, entries }
  }))
  const observation = observations[0]
  if (observations.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(observation))) {
    throw Error('Source RPCs disagree on finalized journal evidence.')
  }
  if (!observation.entries.length && (BigInt(observation.sourceSequence) !== BigInt(first) - 1n
    || (previous && BigInt(observation.sourceBlock) === BigInt(previous.sourceBlock)))) return undefined
  const { entries, ...head } = observation
  const batch = { first: String(first), ...head }
  return {
    entries, batch, types,
    domain: { name: 'CoinCollect NFT Journal', version: '3.4', chainId: 31337, verifyingContract: verifier },
    value: { adapter, sourceJournal, chain, collection, ...batch, entriesHash: utils.keccak256(utils.defaultAbiCoder.encode([entryType], [entries])) },
  }
}

module.exports = { collectFinalizedJournal, entryType, types }
