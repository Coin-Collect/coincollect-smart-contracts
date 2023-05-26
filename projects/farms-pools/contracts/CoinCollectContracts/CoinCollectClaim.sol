// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import '@openzeppelin/contracts/security/ReentrancyGuard.sol';
import '@openzeppelin/contracts/access/Ownable.sol';
import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import '@openzeppelin/contracts/utils/math/SafeMath.sol';
import '@openzeppelin/contracts/token/ERC721/IERC721.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';

interface IWalletOfOwner {
  function walletOfOwner(address _owner) external view returns(uint256[] memory);
}

contract CoinCollectClaim is Ownable, ReentrancyGuard {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    mapping(uint => bool) public claimDisabled;
    Claim[] public claims;
    uint256 loop = 0;

    //loop -> claimId -> token => tokenId => amount
    mapping(uint => mapping(uint => mapping(address => mapping(uint => bool)))) public nftRewardsClaimed;

    //token => weight
    mapping(address => uint) public communityCollectionWeights;
    address[] public communityCollections = [address(0x11DdF94710AD390063357D532042Bd5f23A3fBd6), address(0x0a846Dd40152d6fE8CB4DE4107E0b063B6D6b3F9), address(0x117D6870e6dE9faBcB40C34CceDD5228C63e3a1e)];

    uint256 public MAX_TOKEN_WEIGHT = 100; 

    struct Claim {
        IERC20 rewardToken; 
        uint256 baseAmount;
        uint256 amountLimit; //unused!
        address targetCollectionAddress;
        uint256 targetCollectionWeight;
    }

    struct CollectionInfo {
        address collectionAddress;
        uint256[] nftIds;
    }

    modifier isClaimAvailable(uint _claimId) {
        require(!claimDisabled[loop], "loop already finish");
        _;
    }
    
    constructor(IERC20[] memory _rewardToken, uint256[] memory _baseAmount, uint256[] memory _amountLimit) {
        require(_rewardToken.length > 0 && _rewardToken.length == _baseAmount.length, "illegal data");
        for (uint i = 0; i < _rewardToken.length; i ++) {
            claims.push(Claim({
            rewardToken: _rewardToken[i],
            baseAmount: _baseAmount[i],
            amountLimit: _amountLimit[i],
            targetCollectionAddress: address(0),
            targetCollectionWeight: 0
        }));
        }

        communityCollectionWeights[address(0x11DdF94710AD390063357D532042Bd5f23A3fBd6)] = 3; // Remove all of them
        communityCollectionWeights[address(0x0a846Dd40152d6fE8CB4DE4107E0b063B6D6b3F9)] = 3; // Remove all of them
        communityCollectionWeights[address(0x117D6870e6dE9faBcB40C34CceDD5228C63e3a1e)] = 3; // Remove all of them
    }

    function setMaxWeight(uint256 _newMaxWeight) public onlyOwner {
        MAX_TOKEN_WEIGHT = _newMaxWeight;
    }

    function addCommunityCollection(address _collectionAddress, uint256 _weight) public onlyOwner {
        communityCollections.push(_collectionAddress);
        communityCollectionWeights[_collectionAddress] = _weight;
    }

    function setCommunityCollection(uint256 _index, address _collectionAddress, uint256 _weight) public onlyOwner {
        communityCollections[_index] = _collectionAddress;
        communityCollectionWeights[_collectionAddress] = _weight;
    }

    function delCommunityCollection(uint256 _index) public onlyOwner {
        delete communityCollections[_index];
    }

    function addClaim(IERC20 _rewardToken, uint256 _baseAmount, uint256 _amountLimit, address _targetCollectionAddress, uint256 _targetCollectionWeight) public onlyOwner {
        claims.push(Claim({
            rewardToken: _rewardToken,
            baseAmount: _baseAmount,
            amountLimit: _amountLimit,
            targetCollectionAddress: _targetCollectionAddress,
            targetCollectionWeight: _targetCollectionWeight
        }));
    }

    function setClaim(uint256 _claimId, IERC20 _rewardToken, uint256 _baseAmount, uint256 _amountLimit, address _targetCollectionAddress, uint256 _targetCollectionWeight) public onlyOwner {
       claims[_claimId].rewardToken = _rewardToken;
       claims[_claimId].baseAmount = _baseAmount;
       claims[_claimId].targetCollectionAddress = _targetCollectionAddress;
       claims[_claimId].targetCollectionWeight = _targetCollectionWeight;
    }

    function claimReward(uint256 _claimId, IERC721[] memory nftTokens, uint256[] memory tokenIds) public isClaimAvailable(_claimId) nonReentrant {
        Claim memory claim = claims[_claimId];

        // Check balances of all nftTokens.
        uint256 totalAmount = calculateTotalAmount(_claimId, nftTokens, tokenIds);
        require(totalAmount > 0, "Not eligible: Not enough nft balance");

        //Check balance and send amount according to amountLimit and balance
        uint rewardBalance = claim.rewardToken.balanceOf(address(this));
        if(rewardBalance > 0) {
            if(rewardBalance >= totalAmount) {
                // Transfer the reward to the user.
                claim.rewardToken.safeTransfer(msg.sender, totalAmount * 10**18);
            } else {
                claim.rewardToken.safeTransfer(msg.sender, rewardBalance * 10**18);
            }
        }
        
    }

    function calculateTotalAmount(uint256 _claimId, IERC721[] memory nftTokens, uint256[] memory tokenIds) internal view returns (uint256) {
        Claim memory claim = claims[_claimId];
        uint256 totalWeights = 0;
        
        for (uint256 i = 0; i < nftTokens.length; i++) {
            IERC721 collectionToken = nftTokens[i];
            uint256 tokenId = tokenIds[i];
            require(collectionToken.ownerOf(tokenId) == msg.sender, "Not the owner of NFT");
            if (!isNFTClaimed(_claimId, address(collectionToken), tokenId)) {
                
                if(address(collectionToken) == claim.targetCollectionAddress) {
                    //Target collection weight
                    totalWeights += claim.targetCollectionWeight;
                } else {
                    //Community collection weights
                    totalWeights += communityCollectionWeights[address(collectionToken)];
                }

                nftRewardsClaimed[loop][_claimId][address(collectionToken)][tokenId] == true;
                
                //If you have 5 nft, you will get max weight
                /*if (totalWeights >= MAX_TOKEN_WEIGHT) {
                    totalWeights = MAX_TOKEN_WEIGHT; //double amount
                    break;
                }*/
            }
            
        }

        uint amount = claim.baseAmount * totalWeights;
    
        return amount;
    }

    function isNFTClaimed(uint256 _claimId, address _collectionAddress, uint256 _tokenId) internal view returns (bool) {
        return nftRewardsClaimed[loop][_claimId][_collectionAddress][_tokenId] == true;
    }



function getWeightForCollection(uint _claimId, address _collectionAddress, uint[] memory tokenIds) internal view returns (uint256) {
    uint256 totalWeights = 0;

    for (uint256 i = 0; i < tokenIds.length; i++) {
            
            uint256 tokenId = tokenIds[i];
            if (!isNFTClaimed(_claimId, _collectionAddress, tokenId)) {
                totalWeights += communityCollectionWeights[_collectionAddress];
            }
            
        }

        return totalWeights;
}
    


function getInfo(address _owner) external view returns (CollectionInfo[] memory, CollectionInfo[] memory, uint[] memory,  uint[] memory) {
    CollectionInfo[] memory communityNfts = new CollectionInfo[](communityCollections.length);
    CollectionInfo[] memory targetNfts = new CollectionInfo[](claims.length);
    uint[] memory totalWeights = new uint[](claims.length);
    uint[] memory rewardBalances = new uint[](claims.length);
    
    

    // Get all community collections and token ids to generate weights
    for (uint256 i = 0; i < communityCollections.length; i++) {
        address collectionAddress = communityCollections[i];
        IWalletOfOwner w = IWalletOfOwner(collectionAddress);
        uint256[] memory nftIds = w.walletOfOwner(_owner);
        communityNfts[i] = CollectionInfo(collectionAddress, nftIds);
    }


    // Work for each claim
    for (uint256 claimIndex = 0; claimIndex < claims.length; claimIndex++) {
        Claim memory claim = claims[claimIndex];

        rewardBalances[claimIndex] = claim.rewardToken.balanceOf(address(this));

        // Get target nfts according to claim id
        address targetCollectionAddress = claim.targetCollectionAddress;
        if(targetCollectionAddress != address(0)) {
            IWalletOfOwner w = IWalletOfOwner(targetCollectionAddress);
            uint256[] memory nftIds = w.walletOfOwner(_owner);
            targetNfts[claimIndex] = CollectionInfo(targetCollectionAddress, nftIds);
        }

        // Calculate weights for each community token id
        for (uint256 y = 0; y < communityNfts.length; y++) {
            address collectionAddress = communityNfts[y].collectionAddress;
            uint256[] memory tokenIds = communityNfts[y].nftIds;

            totalWeights[claimIndex] += getWeightForCollection(claimIndex, collectionAddress, tokenIds);
        }

        // Add weight for target nft
        if(claim.targetCollectionWeight != 0) {
            address collectionAddress = targetNfts[claimIndex].collectionAddress;
            uint256[] memory tokenIds = targetNfts[claimIndex].nftIds;
            totalWeights[claimIndex] += getWeightForCollection(claimIndex, collectionAddress, tokenIds);
        }

    }

    
    return (communityNfts, targetNfts, totalWeights, rewardBalances);
}


}