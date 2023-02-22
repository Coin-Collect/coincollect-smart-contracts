// SPDX-License-Identifier: MIT

pragma solidity ^0.7.4;

import '@openzeppelin/contracts@3.4.2/token/ERC20/SafeERC20.sol';
import '@openzeppelin/contracts@3.4.2/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts@3.4.2/math/SafeMath.sol';
import '@openzeppelin/contracts@3.4.2/math/Math.sol';
import './core/SafeOwnable.sol';

interface IMintable {
    function mint(address _to, uint256 _amount) external;
}

contract CoinCollectVault is SafeOwnable {
    using SafeERC20 for IERC20;

    event MinterChanged(address minter, bool available);

    uint256 public constant maxSupply = 500000000 * 1e18;
    IERC20 public immutable coinCollectToken;

    mapping(address => uint) public minters;

    constructor(IERC20 _coinCollectToken, address _owner) {
        coinCollectToken = _coinCollectToken;
        if (_owner != address(0)) {
            _transferOwnership(_owner);
        }
    }

    function addMinter(address _minter, uint _amount) external onlyOwner {
        require(_amount != 0 && _minter != address(0) && minters[_minter] == 0, "illegal minter address");
        minters[_minter] = _amount;
        emit MinterChanged(_minter, true);
    }

    function setMinter(address _minter, uint _amount) external onlyOwner {
        require(minters[_minter] > 0 && _amount != 0, "illegal minter");
        minters[_minter] = _amount;
    }

    function delMinter(address _minter) external onlyOwner {
        require(minters[_minter] > 0, "illegal minter");
        delete minters[_minter];
        emit MinterChanged(_minter, false);
    }

    modifier onlyMinter(uint _amount) {
        require(minters[msg.sender] >= _amount, "only minter can do this");
        _;
        minters[msg.sender] -= _amount;
    }

    function mint(address _to, uint _amount) external onlyMinter(_amount) returns (uint) {
        uint remained = _amount;
        //first from balance
        if (remained != 0) {
            uint currentBalance = coinCollectToken.balanceOf(address(this)); 
            uint amount = Math.min(currentBalance, remained);
            if (amount > 0) {
                coinCollectToken.safeTransfer(_to, amount);
                //sub is safe
                remained -= amount;
            }
        }
        //then mint
        if (remained != 0) {
            uint amount = Math.min(maxSupply - coinCollectToken.totalSupply(), remained);
            if (amount > 0) {
                IMintable(address(coinCollectToken)).mint(_to, amount);
                remained -= amount;
            }
        }
        return _amount - remained;
    }

    function mintOnlyFromBalance(address _to, uint _amount) external onlyMinter(_amount) returns (uint) {
        uint remained = _amount;
        //first from balance
        if (remained != 0) {
            uint currentBalance = coinCollectToken.balanceOf(address(this)); 
            uint amount = Math.min(currentBalance, remained);
            if (amount > 0) {
                coinCollectToken.safeTransfer(_to, amount);
                //sub is safe
                remained -= amount;
            }
        }
        return _amount - remained;
    }

    function mintOnlyFromToken(address _to, uint _amount) external onlyMinter(_amount) returns (uint) {
        uint remained = _amount;
        if (remained != 0) {
            uint amount = Math.min(maxSupply - coinCollectToken.totalSupply(), remained);
            if (amount > 0) {
                IMintable(address(coinCollectToken)).mint(_to, amount);
                remained -= amount;
            }
        }
        return _amount - remained;
    }

    function recoverWrongToken(IERC20 _token, uint _amount, address _receiver) external onlyOwner {
        require(_receiver != address(0), "illegal receiver");
        _token.safeTransfer(_receiver, _amount); 
    }

    function execute(address _to, bytes memory _data) external onlyOwner {
        (bool success, ) = _to.call(_data);
        require(success, "failed");
    }

}