// Uniswap V3 Factory ABI (only PairCreated event needed)
export const UNISWAP_V3_FACTORY_ABI = [
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
];

// Aerodrome Factory ABI
export const AERODROME_FACTORY_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, bool indexed stable, address pair, uint256)',
];

// Uniswap V3 Pool ABI (for slot0 price)
export const UNISWAP_V3_POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function liquidity() external view returns (uint128)',
];

// Aerodrome Pair ABI (for getReserves price)
export const AERODROME_PAIR_ABI = [
  'function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function stable() external view returns (bool)',
];

// Uniswap V3 Router ABI
export const UNISWAP_V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountIn)',
];

// Aerodrome Router ABI
export const AERODROME_ROUTER_ABI = [
  `function swapExactETHForTokens(uint amountOutMin, (address from, address to, bool stable, address factory)[] calldata routes, address to, uint deadline) external payable returns (uint[] memory amounts)`,
  `function swapExactTokensForETH(uint amountIn, uint amountOutMin, (address from, address to, bool stable, address factory)[] calldata routes, address to, uint deadline) external returns (uint[] memory amounts)`,
  `function getAmountsOut(uint amountIn, (address from, address to, bool stable, address factory)[] calldata routes) external view returns (uint[] memory amounts)`,
];

// ERC20 ABI
export const ERC20_ABI = [
  'function balanceOf(address owner) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
  'function name() external view returns (string)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
];

// WETH ABI
export const WETH_ABI = [
  'function deposit() external payable',
  'function withdraw(uint256 wad) external',
  'function balanceOf(address owner) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
];
