// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";


contract TokenLocker {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    ///@notice every block cast 3 seconds
    uint256 public constant SECONDS_PER_BLOCK = 3;

    ///@notice the token to lock
    IERC20 public immutable token;

    ///@notice who will receive this token
    address public immutable receiver;

    ///@notice the blockNum of last release, the init value would be the timestamp the contract created
    uint256 public lastReleaseAt;

    ///@notice how many block must be passed before next release
    uint256 public immutable interval;

    ///@notice the amount of one release time
    uint256 public immutable releaseAmount;

    ///@notice the total amount till now
    uint256 public totalReleasedAmount;

    constructor(
        IERC20 _token, address _receiver, uint256 _intervalSeconds, uint256 _releaseAmount
    ) {
        require(_token != IERC20(address(0)), "illegal token");
        token = _token;
        receiver = _receiver; 
        //lastReleaseAt = block.number;
        require(_intervalSeconds > SECONDS_PER_BLOCK, 'illegal interval');
        uint256 interval_ = _intervalSeconds.add(SECONDS_PER_BLOCK).sub(1).div(SECONDS_PER_BLOCK);
        interval = interval_;
        uint256 lastReleaseAt_ = block.number.sub(interval_);
        lastReleaseAt = lastReleaseAt_;
        require(_releaseAmount > 0, 'illegal releaseAmount');
        releaseAmount = _releaseAmount;
    }

    function getClaimInfo() internal view returns (uint256, uint256) {
        uint currentBlockNum = block.number;
        uint intervalBlockNum = currentBlockNum - lastReleaseAt;
        if (intervalBlockNum < interval) {
            return (0, 0);
        }
        uint times = intervalBlockNum.div(interval);
        uint amount = releaseAmount.mul(times);
        if (token.balanceOf(address(this)) < amount) {
            amount = token.balanceOf(address(this));
        }
        return (amount, times);
    }

    function claim() external {
        (uint amount, uint times) = getClaimInfo();
        if (amount == 0 || times == 0) {
            return;
        }
        lastReleaseAt = lastReleaseAt.add(interval.mul(times));
        totalReleasedAmount = totalReleasedAmount.add(amount);
        token.safeTransfer(receiver, amount);
    }

    ///@notice return the amount we can claim now, and the next timestamp we can claim next time
    function lockInfo() external view returns (uint256 amount, uint256 timestamp) {
        (amount, ) = getClaimInfo();
        if (amount == 0) {
            timestamp = block.timestamp.add(interval.sub(block.number.sub(lastReleaseAt)).mul(SECONDS_PER_BLOCK));
        }
    }
}