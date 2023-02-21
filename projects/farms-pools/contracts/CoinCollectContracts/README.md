# Coincollect Farms and Pools

## Setup Instructions

1. Deploy CollectTokenERC20 Contract
2. Deploy Token Lockers
3. Mint, According to Tokenomics
4. Deploy CoinCollectVault
    - coinCollectToken address
    - owner address
5. Give Ownership(Mint permission) of CollectToken to CoinCollectVault
    - transferOwnership(address newOwner)
6. Deploy CoinCollectPool Contract
    - coinCollectVault address
    - rewardPerBlock
    - startBlock
    - owner address


