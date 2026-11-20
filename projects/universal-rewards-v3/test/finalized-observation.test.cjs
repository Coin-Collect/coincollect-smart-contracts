const { test } = require('node:test')
const assert = require('node:assert/strict')
const { utils } = require('ethers')
const { collectFinalizedOwnership } = require('../scripts/finalized-observation.cjs')

const collection = '0x0000000000000000000000000000000000000010'
const account = '0x0000000000000000000000000000000000000020'
const replacement = '0x0000000000000000000000000000000000000030'
const hash = '0x' + '10'.repeat(32)
const otherHash = '0x' + '20'.repeat(32)

function source(id, { chain = '0x2105', latest = '0x68', atHeight = '0x64', pinnedHash = hash, owner = account } = {}) {
  return {
    id,
    request: async (method, params) => {
      if (method === 'eth_chainId') return chain
      if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'finalized') return { hash, number: latest, timestamp: '0x400' }
        assert.equal(params[0], '0x64')
        return { hash: pinnedHash, number: atHeight, timestamp: '0x3f8' }
      }
      assert.equal(method, 'eth_call')
      assert.deepEqual(params[1], { blockHash: hash, requireCanonical: true })
      assert.equal(params[0].to, collection)
      if (params[0].data.startsWith('0x01ffc9a7')) return utils.hexZeroPad('0x01', 32)
      assert.ok(params[0].data.startsWith('0x6352211e'))
      return utils.hexZeroPad(owner, 32)
    },
  }
}

const common = {
  sourceChainId: 8453, collection, tokenId: 2, issuedAt: 1200,
  minimumSourceAge: 60, maximumSourceAge: 1400,
}
const first = source('one.example', { latest: '0x64' })

test('witness reads both clients at the same canonical finalized block', async () => {
  const result = await collectFinalizedOwnership({ ...common, clients: [first, source('two.example')] })
  assert.deepEqual(result, {
    sourceChainId: 8453, collection, tokenId: '2', owner: account, sourceBlock: '100',
    sourceBlockHash: hash, sourceTimestamp: 1016, issuedAt: 1200, validUntil: 2400,
  })
})

test('witness refuses duplicate providers, reorg disagreement, wrong chain, stale blocks and wrong owners', async () => {
  const run = (clients, override = {}) => collectFinalizedOwnership({ ...common, clients, ...override })
  await assert.rejects(run([first, first]), /witness source policy/)
  await assert.rejects(run([first, source('two.example', { pinnedHash: otherHash })]), /disagree on the finalized block/)
  await assert.rejects(run([first, source('two.example', { chain: '0xa4b1' })]), /chain ID mismatch/)
  await assert.rejects(run([first, source('two.example', { owner: replacement })]), /live NFT owner/)
  await assert.rejects(run([first, source('two.example')], { issuedAt: 3000 }), /freshness policy/)
})
