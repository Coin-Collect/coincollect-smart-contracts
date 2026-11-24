const { compileV36 } = require('./compile-v36.cjs')
const { directTreasuryLedger, treasuryRewardFunding } = require('./compile-v37.cjs')
const { batchLedger, rewardTransfer } = require('./compile-v38.cjs')
const { managedBatchAdapter } = require('./compile-v39.cjs')

const instantLedger = 'contracts/v310/UniversalRewardsV310.sol'

function compileV310(additionalEntries = [], exportInput) {
  return compileV36(
    [directTreasuryLedger, treasuryRewardFunding, batchLedger, rewardTransfer, managedBatchAdapter, instantLedger, ...additionalEntries],
    exportInput, true,
    { directTreasuryRewards: true, batchPositions: true, managedBatch: true, instantStart: true },
  )
}

module.exports = { compileV310, instantLedger }
