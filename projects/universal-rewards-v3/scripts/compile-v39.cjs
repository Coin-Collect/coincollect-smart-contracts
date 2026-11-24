const { compileV36 } = require('./compile-v36.cjs')
const { directTreasuryLedger, treasuryRewardFunding } = require('./compile-v37.cjs')
const { batchLedger, rewardTransfer } = require('./compile-v38.cjs')

const managedBatchAdapter = 'contracts/v39/ManagedNftCollectionV39.sol'

function compileV39(additionalEntries = [], exportInput) {
  return compileV36(
    [directTreasuryLedger, treasuryRewardFunding, batchLedger, rewardTransfer, managedBatchAdapter, ...additionalEntries],
    exportInput,
    true,
    { directTreasuryRewards: true, batchPositions: true, managedBatch: true },
  )
}

module.exports = { compileV39, managedBatchAdapter }
