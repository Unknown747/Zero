import 'dotenv/config';

function requireEnv(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env variable: ${key}`);
  return val;
}

function optionalEnv(key, defaultValue) {
  return process.env[key] ?? defaultValue;
}

export const config = {
  // RPC
  rpcWs: requireEnv('BASE_RPC_WS'),
  rpcHttp: requireEnv('BASE_RPC_HTTP'),

  // Wallet
  privateKey: requireEnv('PRIVATE_KEY'),

  // API Keys
  basescanApiKey: requireEnv('BASESCAN_API_KEY'),

  // Contracts - Factories
  uniswapV3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  aerodromeFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',

  // Contracts - Routers
  uniswapV3Router: '0x2626664c2603336E57B271c5C0b26F421741e481',
  aerodromeRouter: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',

  // Quote token
  quoteToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
  WETH: '0x4200000000000000000000000000000000000006',   // WETH on Base

  // Trade settings
  maxPositionSizePct: parseFloat(optionalEnv('MAX_POSITION_SIZE_PCT', '0.4')),
  maxOpenPositions: parseInt(optionalEnv('MAX_OPEN_POSITIONS', '2')),
  minTradeEth: optionalEnv('MIN_TRADE_ETH', '0.001'),
  slippagePct: parseFloat(optionalEnv('SLIPPAGE_PCT', '5')),
  gasLimit: parseInt(optionalEnv('GAS_LIMIT', '500000')),
  gasPriceGwei: parseFloat(optionalEnv('GAS_PRICE_GWEI', '0')),

  // Take Profit
  tp1Pct: parseFloat(optionalEnv('TP1_PCT', '25')),
  tp1SellPct: parseFloat(optionalEnv('TP1_SELL_PCT', '30')),
  tp2Pct: parseFloat(optionalEnv('TP2_PCT', '50')),
  tp2SellPct: parseFloat(optionalEnv('TP2_SELL_PCT', '30')),
  tp3Pct: parseFloat(optionalEnv('TP3_PCT', '100')),
  tp3SellPct: parseFloat(optionalEnv('TP3_SELL_PCT', '20')),

  // Stop Loss
  slPct: parseFloat(optionalEnv('SL_PCT', '15')),
  trailingActivatePct: parseFloat(optionalEnv('TRAILING_ACTIVATE_PCT', '20')),
  trailingDistancePct: parseFloat(optionalEnv('TRAILING_DISTANCE_PCT', '5')),

  // Time exit
  timeExitHours: parseFloat(optionalEnv('TIME_EXIT_HOURS', '2')),
  timeExitMinProfitPct: parseFloat(optionalEnv('TIME_EXIT_MIN_PROFIT_PCT', '5')),

  // Security thresholds
  minLiquidityUsd: parseFloat(optionalEnv('MIN_LIQUIDITY_USD', '5000')),
  maxTaxPct: parseFloat(optionalEnv('MAX_TAX_PCT', '10')),
  maxRiskScore: parseInt(optionalEnv('MAX_RISK_SCORE', '30')),
  holderConcentrationThreshold: parseFloat(optionalEnv('HOLDER_CONCENTRATION_THRESHOLD', '30')),

  // Monitoring
  monitorIntervalMs: parseInt(optionalEnv('MONITOR_INTERVAL_MS', '5000')),
};
