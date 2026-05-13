import 'dotenv/config';
import { ethers } from 'ethers';
import { config } from './src/config.js';
import { logger } from './src/logger.js';
import { startScanner } from './src/scanner.js';
import { checkTokenSecurity } from './src/security.js';
import { PositionManager, Position } from './src/position.js';
import { executeBuy, getTokenBalance } from './src/trade.js';
import { startMonitor } from './src/monitor.js';
import { getTokenPrice } from './src/price.js';

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
const positionManager = new PositionManager();
const processingTokens = new Set(); // prevent duplicate processing

// ─────────────────────────────────────────────────────────────
// Provider + Signer
// ─────────────────────────────────────────────────────────────
let wsProvider;
let httpProvider;
let signer;

function createProviders() {
  httpProvider = new ethers.JsonRpcProvider(config.rpcHttp);
  wsProvider = new ethers.WebSocketProvider(config.rpcWs);
  signer = new ethers.Wallet(config.privateKey, httpProvider);
  logger.info(`Wallet: ${signer.address}`);
}

// ─────────────────────────────────────────────────────────────
// Handle new pair event
// ─────────────────────────────────────────────────────────────
async function handleNewPair({ tokenAddress, pairAddress, blockNumber, dex, fee, stable }) {
  const tokenKey = tokenAddress.toLowerCase();

  if (processingTokens.has(tokenKey)) {
    logger.warn(`Already processing ${tokenAddress}, skipping`);
    return;
  }

  processingTokens.add(tokenKey);

  try {
    logger.info(`\n${'─'.repeat(60)}`);
    logger.info(`New token detected: ${tokenAddress}`);
    logger.info(`DEX: ${dex} | Pair: ${pairAddress} | Block: ${blockNumber}`);

    // ── Check position limit ──────────────────────────────────
    if (!positionManager.canOpenNew()) {
      logger.warn(`Max open positions (${config.maxOpenPositions}) reached. Skipping.`);
      processingTokens.delete(tokenKey);
      return;
    }

    // ── Security Check ────────────────────────────────────────
    logger.security(`Starting security analysis...`);
    const security = await checkTokenSecurity(tokenAddress);

    if (!security.passed) {
      logger.warn(`Token REJECTED. Reasons: ${security.reasons.join(', ')}`);
      processingTokens.delete(tokenKey);
      return;
    }

    logger.success(`Security check PASSED (risk score: ${security.riskScore})`);
    logger.info(`  Liquidity: $${security.liquidity.toFixed(0)}`);
    logger.info(`  Tax: buy=${security.buyTax}% sell=${security.sellTax}%`);
    logger.info(`  Verified: ${security.isVerified}`);
    logger.info(`  Top10 concentration: ${security.concentrationPct.toFixed(1)}%`);

    // ── Compute trade amount ──────────────────────────────────
    const amountInWei = await positionManager.computeTradeAmount(httpProvider, signer.address);
    if (!amountInWei) {
      logger.warn(`Insufficient balance to trade. Skipping.`);
      processingTokens.delete(tokenKey);
      return;
    }

    logger.trade(`Trade amount: ${ethers.formatEther(amountInWei)} ETH`);

    // ── Get entry price before buy ────────────────────────────
    const entryPrice = await getTokenPrice(httpProvider, tokenAddress, pairAddress, dex);
    if (!entryPrice) {
      logger.warn(`Could not fetch entry price for ${tokenAddress}. Skipping.`);
      processingTokens.delete(tokenKey);
      return;
    }

    logger.trade(`Entry price: ${entryPrice}`);

    // ── Execute Buy ───────────────────────────────────────────
    const buyResult = await executeBuy({
      signer,
      provider: httpProvider,
      tokenAddress,
      pairAddress,
      dex,
      amountInWei,
      fee: fee ?? 3000,
      stable: stable ?? false,
    });

    if (!buyResult.success) {
      logger.error(`Buy failed: ${buyResult.error}`);
      processingTokens.delete(tokenKey);
      return;
    }

    // ── Open Position ─────────────────────────────────────────
    const position = new Position({
      tokenAddress,
      pairAddress,
      dex,
      entryPrice,
      amountIn: amountInWei,
      tokenAmount: buyResult.tokenAmount,
      tokenDecimals: buyResult.tokenDecimals,
      symbol: buyResult.symbol,
      fee,
      stable,
    });

    positionManager.add(position);

    logger.success(`\nPosition #${position.id} opened!`);
    logger.success(`  Token: ${buyResult.name} (${buyResult.symbol})`);
    logger.success(`  Amount in: ${ethers.formatEther(amountInWei)} ETH`);
    logger.success(`  Tokens received: ${ethers.formatUnits(buyResult.tokenAmount, buyResult.tokenDecimals)}`);
    logger.success(`  Entry price: ${entryPrice}`);
    logger.info(`${'─'.repeat(60)}\n`);
  } catch (e) {
    logger.error(`handleNewPair error: ${e.message}`);
  } finally {
    processingTokens.delete(tokenKey);
  }
}

// ─────────────────────────────────────────────────────────────
// WebSocket reconnection
// ─────────────────────────────────────────────────────────────
async function reconnectWs() {
  logger.warn(`Reconnecting WebSocket...`);
  try {
    await wsProvider.destroy();
  } catch {}
  wsProvider = new ethers.WebSocketProvider(config.rpcWs);
  startScanner(wsProvider, handleNewPair);
  logger.success(`WebSocket reconnected`);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`
╔═══════════════════════════════════════════════════╗
║         BASE NETWORK SNIPER BOT v1.0             ║
║   Uniswap V3 + Aerodrome | ethers.js v6          ║
╚═══════════════════════════════════════════════════╝
`);

  // Validate env
  logger.info(`Validating configuration...`);
  logger.info(`  RPC HTTP: ${config.rpcHttp.slice(0, 40)}...`);
  logger.info(`  Max position size: ${(config.maxPositionSizePct * 100).toFixed(0)}%`);
  logger.info(`  Max open positions: ${config.maxOpenPositions}`);
  logger.info(`  Slippage: ${config.slippagePct}%`);
  logger.info(`  Stop Loss: ${config.slPct}%`);
  logger.info(`  Min Liquidity: $${config.minLiquidityUsd}`);
  logger.info(`  Max Tax: ${config.maxTaxPct}%`);
  logger.info(`  Max Risk Score: ${config.maxRiskScore}`);

  createProviders();

  // Check wallet balance
  const balance = await httpProvider.getBalance(signer.address);
  logger.info(`Wallet balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    logger.warn(`WARNING: Wallet has 0 ETH. Trades will fail.`);
  }

  // Start scanner
  startScanner(wsProvider, handleNewPair);

  // Start monitor
  startMonitor(httpProvider, signer, positionManager);

  // WebSocket keepalive
  setInterval(async () => {
    try {
      await wsProvider.getBlockNumber();
    } catch {
      await reconnectWs();
    }
  }, 30_000);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.warn(`Shutting down...`);
    const openPositions = positionManager.getAll();
    if (openPositions.length > 0) {
      logger.warn(`WARNING: ${openPositions.length} open position(s) will NOT be auto-sold on shutdown:`);
      openPositions.forEach((p) => logger.warn(`  #${p.id} ${p.symbol} (${p.tokenAddress})`));
    }
    process.exit(0);
  });

  logger.success(`Bot is running. Waiting for new pairs...\n`);
}

main().catch((e) => {
  logger.error(`Fatal error: ${e.message}`);
  process.exit(1);
});
