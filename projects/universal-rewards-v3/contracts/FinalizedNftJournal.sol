// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ManagedNftCollection} from "./ManagedNftCollection.sol";

/// @notice Isolated verifier for an ordered stream from one reviewed source journal per collection.
contract FinalizedNftJournal is EIP712, ReentrancyGuard {
    uint256 public constant MAX_BATCH = 32;
    uint256 public constant MAX_OBSERVATION_AGE = 2 hours;
    bytes32 private constant BATCH_TYPEHASH = keccak256(
        "JournalBatch(address adapter,address sourceJournal,uint256 chain,address collection,uint64 first,uint64 sourceBlock,bytes32 sourceHash,uint64 finalizedAt,uint64 sourceSequence,bytes32 entriesHash)"
    );

    struct Entry {
        ManagedNftCollection.Action action;
        uint256 poolId;
        uint256 tokenId;
        address from;
        address to;
        uint128 amount;
        uint128 balance;
        uint64 occurredAt;
    }

    struct Batch {
        uint64 first;
        uint64 sourceBlock;
        bytes32 sourceHash;
        uint64 finalizedAt;
        uint64 sourceSequence;
    }

    struct Stream {
        address sourceJournal;
        uint64 next;
        uint64 sourceBlock;
        uint64 finalizedAt;
        bytes32 sourceHash;
        uint64 occurredAt;
        bool paused;
    }

    error Unauthorized();
    error InvalidBatch();
    error InvalidWitnesses();

    event EntriesApplied(address indexed adapter, uint64 first, uint64 next, bytes32 sourceHash);
    event IntentSkipped(address indexed adapter, uint64 indexed sequence);
    event StreamPaused(address indexed adapter, bool paused);

    address public immutable admin;
    uint256 public immutable quorum;
    mapping(address => bool) public isWitness;
    mapping(address => Stream) public streams;
    mapping(address => uint64) public finalizedSequence;

    constructor(address governor, address[] memory witnesses, uint256 threshold) EIP712("CoinCollect NFT Journal", "3.4") {
        if (block.chainid != 31337 || governor == address(0) || witnesses.length > 9
            || threshold < 2 || threshold > witnesses.length || 2 * threshold <= witnesses.length) revert InvalidWitnesses();
        admin = governor;
        quorum = threshold;
        for (uint256 i; i < witnesses.length; ++i) {
            address witness = witnesses[i];
            if (witness == address(0) || isWitness[witness]) revert InvalidWitnesses();
            isWitness[witness] = true;
        }
    }

    function register(ManagedNftCollection adapter, address sourceJournal) external {
        if (msg.sender != admin) revert Unauthorized();
        Stream storage stream = streams[address(adapter)];
        if (adapter.journal() != address(this) || stream.next != 0 || sourceJournal == address(0)) revert InvalidBatch();
        stream.sourceJournal = sourceJournal;
        stream.next = 1;
    }

    function setPaused(ManagedNftCollection adapter, bool paused) external {
        if (msg.sender != admin) revert Unauthorized();
        streams[address(adapter)].paused = paused;
        emit StreamPaused(address(adapter), paused);
    }

    function allowsClaims(address adapter) external view returns (bool) {
        Stream storage stream = streams[adapter];
        return stream.next != 0 && !stream.paused && stream.sourceBlock != 0
            && stream.next - 1 == finalizedSequence[adapter]
            && block.timestamp - stream.finalizedAt < MAX_OBSERVATION_AGE;
    }

    function applyBatch(ManagedNftCollection adapter, Batch calldata batch, Entry[] calldata entries, bytes[] calldata signatures)
        external nonReentrant
    {
        Stream storage stream = streams[address(adapter)];
        uint64 knownTip = finalizedSequence[address(adapter)];
        if (entries.length > MAX_BATCH || stream.next == 0 || stream.paused || batch.first != stream.next
            || batch.sourceBlock == 0 || batch.sourceBlock < stream.sourceBlock
            || batch.sourceHash == bytes32(0) || batch.finalizedAt < stream.finalizedAt
            || batch.finalizedAt > block.timestamp || block.timestamp - batch.finalizedAt >= MAX_OBSERVATION_AGE
            || batch.sourceSequence < knownTip || batch.sourceSequence == type(uint64).max
            || uint256(batch.first) - 1 + entries.length > batch.sourceSequence) revert InvalidBatch();
        if (batch.sourceBlock == stream.sourceBlock && (batch.sourceHash != stream.sourceHash
            || batch.finalizedAt != stream.finalizedAt || batch.sourceSequence != knownTip)) revert InvalidBatch();
        if (entries.length == 0 && (batch.sourceBlock == stream.sourceBlock || batch.sourceSequence != stream.next - 1)) {
            revert InvalidBatch();
        }
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            BATCH_TYPEHASH, address(adapter), stream.sourceJournal, adapter.sourceChainId(), adapter.sourceCollection(),
            batch.first, batch.sourceBlock, batch.sourceHash, batch.finalizedAt, batch.sourceSequence, keccak256(abi.encode(entries))
        )));
        if (signatures.length != quorum) revert InvalidWitnesses();
        address last;
        for (uint256 i; i < signatures.length; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer <= last || !isWitness[signer]) revert InvalidWitnesses();
            last = signer;
        }

        for (uint256 i; i < entries.length; ++i) {
            Entry calldata entry = entries[i];
            if (entry.occurredAt < stream.occurredAt || entry.occurredAt > batch.finalizedAt) revert InvalidBatch();
            stream.occurredAt = entry.occurredAt;
            if (entry.action == ManagedNftCollection.Action.Transfer) {
                adapter.applyObservation(entry.action, 0, entry.tokenId, entry.from, entry.to, entry.amount, 0);
            } else if (block.timestamp - entry.occurredAt < MAX_OBSERVATION_AGE) {
                // A failed user intent can be resubmitted on the source. A transfer can never be skipped.
                if (gasleft() < 1_150_000) revert InvalidBatch();
                try adapter.applyObservation{gas: 1_000_000}(
                    entry.action, entry.poolId, entry.tokenId, entry.from, address(0), entry.amount, entry.balance
                ) {} catch (bytes memory reason) {
                    // Unknown failures and exhausted gas must keep the sequence retryable.
                    if (!_knownIntentFailure(reason)) revert InvalidBatch();
                    emit IntentSkipped(address(adapter), batch.first + uint64(i));
                }
            } else emit IntentSkipped(address(adapter), batch.first + uint64(i));
        }
        stream.sourceBlock = batch.sourceBlock;
        stream.sourceHash = batch.sourceHash;
        stream.finalizedAt = batch.finalizedAt;
        stream.next += uint64(entries.length);
        finalizedSequence[address(adapter)] = batch.sourceSequence;
        emit EntriesApplied(address(adapter), batch.first, stream.next, batch.sourceHash);
    }

    function _knownIntentFailure(bytes memory reason) private pure returns (bool) {
        if (reason.length != 4) return false;
        bytes4 selector = bytes4(reason);
        return selector == ManagedNftCollection.InvalidQuantity.selector
            || selector == ManagedNftCollection.IntentUnavailable.selector
            || selector == ManagedNftCollection.NoSeat.selector
            || selector == ManagedNftCollection.PoolLimit.selector
            || selector == ManagedNftCollection.UnsupportedCollection.selector
            || selector == bytes4(keccak256("UnavailablePool()"));
    }
}
