const { compileV36 } = require('./compile-v36.cjs')
const { directTreasuryLedger, treasuryRewardFunding } = require('./compile-v37.cjs')

const batchLedger = 'contracts/v38/UniversalRewardsV38.sol'
const rewardTransfer = 'contracts/v38/RewardTransferV38.sol'

function compileV38(additionalEntries = [], exportInput) {
  return compileV36(
    [directTreasuryLedger, treasuryRewardFunding, batchLedger, rewardTransfer, ...additionalEntries],
    exportInput,
    true,
    { directTreasuryRewards: true, batchPositions: true },
  )
}

module.exports = { compileV38, batchLedger, rewardTransfer }
