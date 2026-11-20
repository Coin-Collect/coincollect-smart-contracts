// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FixtureToken} from "./Fixtures.sol";

contract FixtureWrapped is FixtureToken {
    constructor() FixtureToken(18) {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
}

contract FixtureSwapFactory {
    mapping(address => mapping(address => address)) public getPair;

    function setPair(address tokenA, address tokenB, address pair) external {
        getPair[tokenA][tokenB] = pair;
        getPair[tokenB][tokenA] = pair;
    }
}

contract FixtureSwapPair {
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private lastTimestamp;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address pairFactory, address asset0, address asset1) {
        factory = pairFactory;
        token0 = asset0;
        token1 = asset1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, lastTimestamp);
    }

    function setReserves(uint112 next0, uint112 next1) external {
        _update(next0, next1);
    }

    function execute(address input, address recipient, uint256 spent, uint256 actualOut) external {
        if (input == token0) {
            require(IERC20(token1).transfer(recipient, actualOut));
            _update(reserve0 + uint112(spent), reserve1 - uint112(actualOut));
        } else {
            require(IERC20(token0).transfer(recipient, actualOut));
            _update(reserve0 - uint112(actualOut), reserve1 + uint112(spent));
        }
    }

    function _update(uint112 next0, uint112 next1) private {
        unchecked {
            uint32 elapsed = uint32(block.timestamp) - lastTimestamp;
            if (reserve0 > 0 && reserve1 > 0) {
                price0CumulativeLast += ((uint256(reserve1) << 112) / reserve0) * elapsed;
                price1CumulativeLast += ((uint256(reserve0) << 112) / reserve1) * elapsed;
            }
        }
        reserve0 = next0;
        reserve1 = next1;
        lastTimestamp = uint32(block.timestamp);
    }
}

contract FixtureSwapRouter {
    address public immutable factory;
    address public immutable WETH;
    bool public underpay;

    constructor(address routerFactory, address wrapped) {
        factory = routerFactory;
        WETH = wrapped;
    }

    function setUnderpay(bool enabled) external {
        underpay = enabled;
    }

    function getAmountsOut(uint256 amount, address[] calldata path) public view returns (uint256[] memory amounts) {
        require(path.length == 2);
        FixtureSwapPair pair = FixtureSwapPair(FixtureSwapFactory(factory).getPair(path[0], path[1]));
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        (uint256 reserveIn, uint256 reserveOut) = pair.token0() == path[0] ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 amountWithFee = amount * 9975;
        amounts = new uint256[](2);
        amounts[0] = amount;
        amounts[1] = amountWithFee * reserveOut / (reserveIn * 10_000 + amountWithFee);
    }

    function swapExactTokensForTokens(
        uint256 amount, uint256 minimum, address[] calldata path, address to, uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(deadline >= block.timestamp);
        FixtureSwapPair pair = FixtureSwapPair(FixtureSwapFactory(factory).getPair(path[0], path[1]));
        amounts = getAmountsOut(amount, path);
        require(amounts[1] >= minimum);
        require(IERC20(path[0]).transferFrom(msg.sender, address(pair), amount));
        pair.execute(path[0], to, amount, underpay ? amounts[1] / 2 : amounts[1]);
    }
}
