const { compileV36 } = require('./compile-v36.cjs')

const directTreasuryLedger = 'contracts/v37/UniversalRewardsV37.sol'
const treasuryRewardFunding = 'contracts/v37/TreasuryRewardFunding.sol'

function compileV37(additionalEntries = [], exportInput) {
  return compileV36([directTreasuryLedger, treasuryRewardFunding, ...additionalEntries], exportInput, true,
    { directTreasuryRewards: true })
}

module.exports = { compileV37, directTreasuryLedger, treasuryRewardFunding }
