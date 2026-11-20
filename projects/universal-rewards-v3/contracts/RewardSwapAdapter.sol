// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ICoinCollectSwapRouter {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function getAmountsOut(uint256 amount, address[] calldata path) external view returns (uint256[] memory);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory);
}

interface ICoinCollectSwapFactory {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

interface ICoinCollectSwapPair {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 timestamp);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

/// @notice Exact-input direct routes with time-weighted pricing and bounded exposure.
contract RewardSwapAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_OBSERVATION = 30 minutes;
    uint256 public constant MAX_OBSERVATION = 6 hours;
    uint256 public constant MAX_PRICE_AGE = 2 hours;
    uint256 public constant MAX_DEADLINE = 5 minutes;
    uint256 public constant MAX_RESERVE_SHARE_BPS = 50;
    uint256 public constant MAX_SPOT_DEVIATION_BPS = 100;
    uint256 public constant MAX_TWAP_SLIPPAGE_BPS = 150;
    uint256 public constant MAX_QUOTE_SLIPPAGE_BPS = 50;
    uint256 private constant BPS = 10_000;
    uint256 private constant Q112 = 1 << 112;

    struct Route {
        address pair;
        bytes32 pairCodeHash;
        bool inIsToken0;
        uint112 minReserveIn;
        uint112 minReserveOut;
        uint64 sampleAt;
        uint64 averageAt;
        uint256 sample;
        uint256 averagePrice;
    }

    error Unauthorized();
    error InvalidRouter();
    error UnconfiguredRoute();
    error InvalidPair();
    error ObservationTooEarly();
    error StalePrice();
    error LowLiquidity();
    error PriceDeviation();
    error InvalidDeadline();
    error InsufficientOutput();
    error UnexpectedTransfer();
    error Paused();

    event RouteConfigured(address indexed input, address indexed output, address indexed pair);
    event Observed(address indexed input, address indexed output, uint64 timestamp, uint256 averagePrice);
    event PauseChanged(bool paused);
    event Swapped(address indexed payer, address indexed input, address indexed output, uint256 spent, uint256 received);

    address public immutable admin;
    ICoinCollectSwapRouter public immutable router;
    ICoinCollectSwapFactory public immutable factory;
    address public immutable wrappedNative;
    bytes32 public immutable routerCodeHash;
    bool public paused;
    mapping(address => mapping(address => Route)) private routes;

    constructor(address adapterAdmin, address routerAddress, bytes32 expectedRouterHash, address expectedFactory, address wrapped) {
        if (
            adapterAdmin == address(0) || routerAddress.code.length == 0
                || routerAddress.codehash != expectedRouterHash || expectedFactory.code.length == 0
                || wrapped.code.length == 0 || ICoinCollectSwapRouter(routerAddress).factory() != expectedFactory
                || ICoinCollectSwapRouter(routerAddress).WETH() != wrapped
        ) revert InvalidRouter();
        admin = adapterAdmin;
        router = ICoinCollectSwapRouter(routerAddress);
        factory = ICoinCollectSwapFactory(expectedFactory);
        wrappedNative = wrapped;
        routerCodeHash = expectedRouterHash;
    }

    /// @notice Route floors and bytecode identity are fixed once accepted.
    function configureRoute(
        address input,
        address output,
        address pairAddress,
        bytes32 expectedPairHash,
        uint112 minReserveIn,
        uint112 minReserveOut
    ) external {
        if (msg.sender != admin) revert Unauthorized();
        Route storage route = routes[input][output];
        ICoinCollectSwapPair pair = ICoinCollectSwapPair(pairAddress);
        if (
            input == output || input.code.length == 0 || output.code.length == 0 || route.pair != address(0)
                || pairAddress.code.length == 0 || pairAddress.codehash != expectedPairHash
                || pair.factory() != address(factory) || factory.getPair(input, output) != pairAddress
                || minReserveIn == 0 || minReserveOut == 0
        ) revert InvalidPair();
        address token0 = pair.token0();
        address token1 = pair.token1();
        if (!((token0 == input && token1 == output) || (token0 == output && token1 == input))) revert InvalidPair();
        route.pair = pairAddress;
        route.pairCodeHash = expectedPairHash;
        route.inIsToken0 = token0 == input;
        route.minReserveIn = minReserveIn;
        route.minReserveOut = minReserveOut;
        emit RouteConfigured(input, output, pairAddress);
    }

    function setPaused(bool value) external {
        if (msg.sender != admin) revert Unauthorized();
        paused = value;
        emit PauseChanged(value);
    }

    function routeState(address input, address output) external view returns (Route memory) {
        return routes[input][output];
    }

    /// @notice A long observation gap discards the prior price and starts a fresh window.
    function observe(address input, address output) external {
        Route storage route = _route(input, output);
        (uint112 reserveIn, uint112 reserveOut, uint32 lastTimestamp) = _reserves(route);
        uint256 elapsed = block.timestamp - route.sampleAt;
        if (route.sampleAt != 0 && elapsed < MIN_OBSERVATION) revert ObservationTooEarly();
        ICoinCollectSwapPair pair = ICoinCollectSwapPair(route.pair);
        uint256 cumulative = route.inIsToken0 ? pair.price0CumulativeLast() : pair.price1CumulativeLast();
        unchecked {
            // The original pair wraps uint32 timestamps and uint256 accumulators.
            uint32 sincePairUpdate = uint32(block.timestamp) - lastTimestamp;
            cumulative += (uint256(reserveOut) * Q112 / reserveIn) * sincePairUpdate;
            if (route.sampleAt != 0 && elapsed <= MAX_OBSERVATION) {
                route.averagePrice = (cumulative - route.sample) / elapsed;
                route.averageAt = uint64(block.timestamp);
            } else {
                route.averagePrice = 0;
                route.averageAt = 0;
            }
        }
        route.sample = cumulative;
        route.sampleAt = uint64(block.timestamp);
        emit Observed(input, output, route.sampleAt, route.averagePrice);
    }

    function preview(address input, address output, uint256 amount, uint256 callerMinimum)
        public view returns (uint256 quoted, uint256 minimum)
    {
        if (paused) revert Paused();
        if (address(router).codehash != routerCodeHash) revert InvalidRouter();
        Route storage route = _route(input, output);
        uint256 average = route.averagePrice;
        if (average == 0 || block.timestamp - route.averageAt > MAX_PRICE_AGE) revert StalePrice();
        (uint112 reserveIn, uint112 reserveOut,) = _reserves(route);
        if (amount == 0 || amount > uint256(reserveIn) * MAX_RESERVE_SHARE_BPS / BPS) revert LowLiquidity();

        uint256 spot = uint256(reserveOut) * Q112 / reserveIn;
        uint256 difference = spot > average ? spot - average : average - spot;
        if (difference * BPS > average * MAX_SPOT_DEVIATION_BPS) revert PriceDeviation();
        uint256 twapOut = Math.mulDiv(amount, average, Q112);

        uint256[] memory quote = router.getAmountsOut(amount, _path(input, output));
        if (quote.length != 2 || quote[0] != amount) revert InvalidRouter();
        quoted = quote[1];
        minimum = Math.max(
            callerMinimum,
            Math.max(twapOut * (BPS - MAX_TWAP_SLIPPAGE_BPS) / BPS, quoted * (BPS - MAX_QUOTE_SLIPPAGE_BPS) / BPS)
        );
        if (minimum == 0 || minimum > quoted) revert InsufficientOutput();
    }

    function swapExact(address input, address output, uint256 amount, uint256 callerMinimum, uint256 deadline)
        external nonReentrant returns (uint256 received)
    {
        if (deadline < block.timestamp || deadline - block.timestamp > MAX_DEADLINE) revert InvalidDeadline();
        (, uint256 minimum) = preview(input, output, amount, callerMinimum);
        IERC20 asset = IERC20(input);
        IERC20 reward = IERC20(output);
        uint256 startInput = asset.balanceOf(address(this));
        uint256 startOutput = reward.balanceOf(msg.sender);
        asset.safeTransferFrom(msg.sender, address(this), amount);
        if (asset.balanceOf(address(this)) != startInput + amount) revert UnexpectedTransfer();

        asset.forceApprove(address(router), amount);
        router.swapExactTokensForTokens(amount, minimum, _path(input, output), msg.sender, deadline);
        asset.forceApprove(address(router), 0);
        if (asset.balanceOf(address(this)) != startInput) revert UnexpectedTransfer();
        received = reward.balanceOf(msg.sender) - startOutput;
        if (received < minimum) revert InsufficientOutput();
        emit Swapped(msg.sender, input, output, amount, received);
    }

    function _route(address input, address output) private view returns (Route storage route) {
        route = routes[input][output];
        if (route.pair == address(0)) revert UnconfiguredRoute();
        if (route.pair.codehash != route.pairCodeHash || factory.getPair(input, output) != route.pair) revert InvalidPair();
    }

    function _reserves(Route storage route) private view returns (uint112 reserveIn, uint112 reserveOut, uint32 timestamp) {
        (uint112 reserve0, uint112 reserve1, uint32 lastTimestamp) = ICoinCollectSwapPair(route.pair).getReserves();
        (reserveIn, reserveOut) = route.inIsToken0 ? (reserve0, reserve1) : (reserve1, reserve0);
        if (reserveIn < route.minReserveIn || reserveOut < route.minReserveOut) revert LowLiquidity();
        timestamp = lastTimestamp;
    }

    function _path(address input, address output) private pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = input;
        path[1] = output;
    }
}
