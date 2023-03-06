// SPDX-License-Identifier: MIT

pragma solidity >=0.5.16;

import './CoinCollectPair.sol';
import '../libraries/CoinCollectLibrary.sol';

contract CoinCollectFactory {
    bytes32 public constant INIT_CODE_PAIR_HASH = keccak256(abi.encodePacked(type(CoinCollectPair).creationCode));

    address public feeTo;
    address public feeToSetter;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint);

    constructor(address _feeToSetter) {
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view returns (uint) {
        return allPairs.length;
    }

    function expectPairFor(address token0, address token1) public view returns (address) {
        return CoinCollectLibrary.pairFor(address(this), token0, token1);
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, 'CoinCollect: IDENTICAL_ADDRESSES');
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'CoinCollect: ZERO_ADDRESS');
        require(getPair[token0][token1] == address(0), 'CoinCollect: PAIR_EXISTS'); // single check is sufficient
        bytes memory bytecode = type(CoinCollectPair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        ICoinCollectPair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // populate mapping in the reverse direction
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, 'CoinCollect: FORBIDDEN');
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, 'CoinCollect: FORBIDDEN');
        feeToSetter = _feeToSetter;
    }
}
