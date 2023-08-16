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
    uint256 public loop = 0;

    //loop -> claimId -> token => tokenId => amount
    mapping(uint => mapping(uint => mapping(address => mapping(uint => bool)))) public nftRewardsClaimed;

    //loop -> claimId -> wallet address
    mapping(uint => mapping(uint => mapping(address => uint))) public walletClaimedCount;

    //token => weight
    mapping(address => uint) public communityCollectionWeights;
    address[] public communityCollections;


    struct Claim {
        IERC20 rewardToken; 
        uint256 baseAmount;
        uint256 nftLimit;
        address targetCollectionAddress;
        uint256 targetCollectionWeight;
    }

    struct CollectionInfo {
        address collectionAddress;
        uint256[] nftIds;
    }

    struct UserClaimInfo {
        uint256 totalWeights;
        uint256 remainingClaims;
    }

    modifier isClaimAvailable(uint _claimId) {
        require(!claimDisabled[_claimId], "Claim disabled!");
        _;
    }
    
    constructor(IERC20[] memory _rewardToken, uint256[] memory _baseAmount, uint256[] memory _nftLimit, address[] memory _targetCollectionAddress, uint256[] memory _targetCollectionWeight) {
        require(_rewardToken.length > 0 && _rewardToken.length == _baseAmount.length, "illegal data");
        for (uint i = 0; i < _rewardToken.length; i ++) {
            claims.push(Claim({
            rewardToken: _rewardToken[i],
            baseAmount: _baseAmount[i],
            nftLimit: _nftLimit[i],
            targetCollectionAddress: _targetCollectionAddress[i],
            targetCollectionWeight: _targetCollectionWeight[i]
        }));
        }


    }

    function toggleClaim(uint256 _claimIndex) public onlyOwner {
        claimDisabled[_claimIndex] = !claimDisabled[_claimIndex];
    }

    function setWalletClaimedCount(uint256 _claimIndex, address[] memory _user, uint256[] memory _amount) public onlyOwner {
        for (uint i = 0; i < _user.length; i ++) {
            walletClaimedCount[loop][_claimIndex][_user[i]] = _amount[i];
        }
    }

    function setNftRewardsClaimed(uint256 _claimIndex, address[] memory _collectionAddresses, uint256[] memory _tokenIds, bool[] memory _status) public onlyOwner {
        for (uint i = 0; i < _collectionAddresses.length; i ++) {
            nftRewardsClaimed[loop][_claimIndex][_collectionAddresses[i]][_tokenIds[i]] = _status[i];
        }
    }

    function addCommunityCollections(address[] memory _collectionAddress, uint256[] memory _weight) public onlyOwner {
        require(_collectionAddress.length == _weight.length, "wrong data length");
        for (uint i = 0; i < _collectionAddress.length; i ++) {
            communityCollectionWeights[_collectionAddress[i]] = _weight[i];
        }
        communityCollections = _collectionAddress;
    }

    function setCommunityCollection(uint256 _index, address _collectionAddress, uint256 _weight) public onlyOwner {
        communityCollections[_index] = _collectionAddress;
        communityCollectionWeights[_collectionAddress] = _weight;
    }


    function addClaim(IERC20 _rewardToken, uint256 _baseAmount, uint256 _nftLimit, address _targetCollectionAddress, uint256 _targetCollectionWeight) public onlyOwner {
        claims.push(Claim({
            rewardToken: _rewardToken,
            baseAmount: _baseAmount,
            nftLimit: _nftLimit,
            targetCollectionAddress: _targetCollectionAddress,
            targetCollectionWeight: _targetCollectionWeight
        }));
    }

    function setClaim(uint256 _claimId, IERC20 _rewardToken, uint256 _baseAmount, uint256 _nftLimit, address _targetCollectionAddress, uint256 _targetCollectionWeight) public onlyOwner {
       claims[_claimId].rewardToken = _rewardToken;
       claims[_claimId].baseAmount = _baseAmount;
       claims[_claimId].nftLimit = _nftLimit;
       claims[_claimId].targetCollectionAddress = _targetCollectionAddress;
       claims[_claimId].targetCollectionWeight = _targetCollectionWeight;
    }

    function claimReward(uint256 _claimId, IERC721[] memory nftTokens, uint256[] memory tokenIds) public isClaimAvailable(_claimId) nonReentrant {
        Claim memory claim = claims[_claimId];
        require(walletClaimedCount[loop][_claimId][msg.sender] < claim.nftLimit, "Claim limit reached");

        // Check balances of all nftTokens.
        uint256 totalAmount = calculateTotalAmount(_claimId, nftTokens, tokenIds);
        require(totalAmount > 0, "Not eligible: Not enough nft balance");

        // Transfer the reward to the user.
        claim.rewardToken.safeTransfer(msg.sender, totalAmount);  
    }

    function calculateTotalAmount(uint256 _claimId, IERC721[] memory nftTokens, uint256[] memory tokenIds) internal returns (uint256) {
        Claim memory claim = claims[_claimId];
        uint256 totalWeights = 0;
        uint256 claimCount = 0;
        
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

                nftRewardsClaimed[loop][_claimId][address(collectionToken)][tokenId] = true;
                claimCount += 1;

                // NFT claim limit
                if (claimCount >= claim.nftLimit - walletClaimedCount[loop][_claimId][msg.sender]) {
                    // Limit claim process
                    break;
                }
                
            }
            
        }

        if(claimCount > 0) {
            walletClaimedCount[loop][_claimId][msg.sender] += claimCount;
        }
        uint amount = claim.baseAmount * totalWeights;
    
        return amount;
    }

    function isNFTClaimed(uint256 _claimId, address _collectionAddress, uint256 _tokenId) internal view returns (bool) {
        return nftRewardsClaimed[loop][_claimId][_collectionAddress][_tokenId] == true;
    }



    function getWeightForCollection(uint _claimId, address _collectionAddress, uint[] memory tokenIds, uint targetCollectionWeight, uint nftLimit) internal view returns (uint256, uint256) {
        uint256 totalWeights = 0;
        uint256 claimCount = 0;


        for (uint256 i = 0; i < tokenIds.length; i++) {
                
                uint256 tokenId = tokenIds[i];
                if (!isNFTClaimed(_claimId, _collectionAddress, tokenId)) {
                    if(targetCollectionWeight > 0) {
                        // Add weights for target collection
                        totalWeights += targetCollectionWeight;
                    } else {
                        // Add weights for community collection
                        totalWeights += communityCollectionWeights[_collectionAddress];
                    }
                    claimCount += 1;
                    // NFT claim limit
                    if (claimCount >= nftLimit) {
                        // Limit claim process
                        break;
                    }
                }
                
            }

            return (totalWeights, claimCount);
    }
    


    function getInfo(address _owner) external view returns (CollectionInfo[] memory, CollectionInfo[] memory, UserClaimInfo[] memory,  uint[] memory) {
        CollectionInfo[] memory communityNfts = new CollectionInfo[](communityCollections.length);
        CollectionInfo[] memory targetNfts = new CollectionInfo[](claims.length);
        uint[] memory rewardBalances = new uint[](claims.length);
        UserClaimInfo[] memory userClaimInfo = new UserClaimInfo[](claims.length);
        
        

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

            // If nft claim limit already reached, weight will be zero
            if(walletClaimedCount[loop][claimIndex][msg.sender] >= claim.nftLimit) {
                continue;
            }
            uint256 remainingClaimCount = claim.nftLimit - walletClaimedCount[loop][claimIndex][msg.sender];
            userClaimInfo[claimIndex].remainingClaims = remainingClaimCount;

            // Add weight for target nfts(priority)
            if(claim.targetCollectionWeight != 0) {
                address collectionAddress = targetNfts[claimIndex].collectionAddress;
                uint256[] memory tokenIds = targetNfts[claimIndex].nftIds;
                (uint weight, uint claimedCount) = getWeightForCollection(claimIndex, collectionAddress, tokenIds, claim.targetCollectionWeight, remainingClaimCount);
                userClaimInfo[claimIndex].totalWeights += weight;
                remainingClaimCount -= claimedCount;
                if(remainingClaimCount <= 0) {
                    continue;
                }
            }

            // Add weights for each community nfts
            for (uint256 y = 0; y < communityNfts.length; y++) {
                address collectionAddress = communityNfts[y].collectionAddress;
                uint256[] memory tokenIds = communityNfts[y].nftIds;

                (uint weight, uint claimedCount) = getWeightForCollection(claimIndex, collectionAddress, tokenIds, 0, remainingClaimCount);
                userClaimInfo[claimIndex].totalWeights += weight;
                remainingClaimCount -= claimedCount;
                if(remainingClaimCount <= 0) {
                    break;
                }
            }


        }

        
        return (communityNfts, targetNfts, userClaimInfo, rewardBalances);
    }



    function transferTokens(IERC20[] memory _tokens) external onlyOwner {
        for (uint256 i = 0; i < _tokens.length; i++) {
            IERC20 token = _tokens[i];
            token.safeTransfer(msg.sender, token.balanceOf(address(this)));
        }
    }

    function increaseLoop() public onlyOwner {
        loop = loop + 1;
    }

    
}