// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Quorum-authenticated ownership observations for isolated testing. A certificate
/// describes an already finalized source block and does not give an atomic ownership guarantee.
contract FinalizedOwnershipVerifier is EIP712 {
    uint256 public constant MAX_CERTIFICATE_LIFETIME = 20 minutes;
    uint256 public constant MAX_SIGNERS = 9;
    bytes32 public constant OBSERVATION_TYPEHASH = keccak256(
        "OwnershipObservation(uint256 sourceChainId,address collection,uint256 tokenId,address owner,uint64 sourceBlock,bytes32 sourceBlockHash,uint64 sourceTimestamp,uint64 issuedAt,uint64 validUntil)"
    );

    struct SourcePolicy {
        uint256 sourceChainId;
        uint32 minimumSourceAge;
        uint32 maximumSourceAge;
    }

    struct OwnershipObservation {
        uint256 sourceChainId;
        address collection;
        uint256 tokenId;
        address owner;
        uint64 sourceBlock;
        bytes32 sourceBlockHash;
        uint64 sourceTimestamp;
        uint64 issuedAt;
        uint64 validUntil;
    }

    struct RecordedOwnership {
        address owner;
        uint64 sourceBlock;
        bytes32 sourceBlockHash;
        uint64 sourceTimestamp;
        uint64 validUntil;
    }

    error UnsupportedSettlement();
    error InvalidConfiguration();
    error InvalidObservation();
    error SupersededObservation();
    error InsufficientWitnesses();

    event OwnershipRecorded(
        uint256 indexed sourceChainId,
        address indexed collection,
        uint256 indexed tokenId,
        address owner,
        uint64 sourceBlock,
        bytes32 sourceBlockHash,
        uint64 validUntil
    );

    uint256 public immutable quorum;
    mapping(address => bool) public isWitness;
    mapping(uint256 => SourcePolicy) public sourcePolicies;
    mapping(bytes32 => RecordedOwnership) private records;

    constructor(address[] memory witnesses, uint256 required, SourcePolicy[] memory sources)
        EIP712("CoinCollect Finalized Ownership", "1")
    {
        if (block.chainid != 31337) revert UnsupportedSettlement();
        if (required < 2 || required > witnesses.length || witnesses.length > MAX_SIGNERS || sources.length == 0
            || sources.length > 16) revert InvalidConfiguration();
        quorum = required;

        for (uint256 i; i < witnesses.length; ++i) {
            address witness = witnesses[i];
            if (witness == address(0) || isWitness[witness]) revert InvalidConfiguration();
            isWitness[witness] = true;
        }
        for (uint256 i; i < sources.length; ++i) {
            SourcePolicy memory source = sources[i];
            if (
                source.sourceChainId == 0 || source.sourceChainId == 137 || source.sourceChainId == 31337
                    || sourcePolicies[source.sourceChainId].maximumSourceAge != 0
                    || source.minimumSourceAge == 0 || source.maximumSourceAge <= source.minimumSourceAge
                    || source.maximumSourceAge > 1 days
            ) revert InvalidConfiguration();
            sourcePolicies[source.sourceChainId] = source;
        }
    }

    function supportsSource(uint256 sourceChainId) external view returns (bool) {
        return sourcePolicies[sourceChainId].maximumSourceAge != 0;
    }

    function latest(uint256 sourceChainId, address collection, uint256 tokenId)
        external view returns (RecordedOwnership memory)
    {
        return records[_key(sourceChainId, collection, tokenId)];
    }

    function freshOwner(uint256 sourceChainId, address collection, uint256 tokenId)
        external view returns (address owner, uint64 validUntil)
    {
        RecordedOwnership storage record = records[_key(sourceChainId, collection, tokenId)];
        if (block.timestamp >= record.validUntil) return (address(0), 0);
        return (record.owner, record.validUntil);
    }

    function record(OwnershipObservation calldata evidence, bytes[] calldata signatures) external {
        SourcePolicy storage policy = sourcePolicies[evidence.sourceChainId];
        if (
            policy.maximumSourceAge == 0 || evidence.collection == address(0)
                || evidence.sourceBlock == 0 || evidence.sourceBlockHash == bytes32(0)
                || evidence.sourceTimestamp == 0 || evidence.sourceTimestamp > evidence.issuedAt
                || evidence.issuedAt > block.timestamp || evidence.validUntil <= block.timestamp
                || evidence.validUntil - evidence.issuedAt > MAX_CERTIFICATE_LIFETIME
                || evidence.issuedAt - evidence.sourceTimestamp < policy.minimumSourceAge
                || evidence.validUntil - evidence.sourceTimestamp > policy.maximumSourceAge
        ) revert InvalidObservation();
        bytes32 key = _key(evidence.sourceChainId, evidence.collection, evidence.tokenId);
        RecordedOwnership storage previous = records[key];
        if (evidence.sourceBlock <= previous.sourceBlock || evidence.sourceTimestamp < previous.sourceTimestamp) {
            revert SupersededObservation();
        }

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            OBSERVATION_TYPEHASH,
            evidence.sourceChainId,
            evidence.collection,
            evidence.tokenId,
            evidence.owner,
            evidence.sourceBlock,
            evidence.sourceBlockHash,
            evidence.sourceTimestamp,
            evidence.issuedAt,
            evidence.validUntil
        )));
        if (signatures.length != quorum) revert InsufficientWitnesses();
        address lastWitness;
        for (uint256 i; i < signatures.length; ++i) {
            address witness = ECDSA.recover(digest, signatures[i]);
            if (witness <= lastWitness || !isWitness[witness]) revert InsufficientWitnesses();
            lastWitness = witness;
        }

        records[key] = RecordedOwnership(
            evidence.owner, evidence.sourceBlock, evidence.sourceBlockHash, evidence.sourceTimestamp, evidence.validUntil
        );
        emit OwnershipRecorded(
            evidence.sourceChainId, evidence.collection, evidence.tokenId, evidence.owner, evidence.sourceBlock,
            evidence.sourceBlockHash, evidence.validUntil
        );
    }

    function _key(uint256 sourceChainId, address collection, uint256 tokenId) private pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, collection, tokenId));
    }
}
