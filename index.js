import 'dotenv/config';
import { ethers } from 'ethers';
import { config } from './src/config.js';
import { logger } from './src/logger.js';
import { startScanner } from './src/scanner.js';
import { checkTokenSecurity } from './src/security.js';
import { PositionManager, Position } from './src/position.js';
import { executeBuy } from './src/trade.js';
import { startMonitor } from './src/monitor.js';
import { getTokenPrice } from './src/price.js';

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
const positionManager = new PositionManager();
const processingTokens = new Set(); // deduplicate concurrent pair events

// ─────────────────────────────────────────────────────────────
// Providers + Signer
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
    logger.warn(`Already processing ${tokenAddress}, skipping duplicate`);
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
      return;
    }

    // ── Security Check ────────────────────────────────────────
    logger.security(`Starting security analysis...`);
    const security = await checkTokenSecurity(tokenAddress);

    if (!security.passed) {
      logger.warn(`Token REJECTED. Reasons: ${security.reasons.join(' | ')}`);
      return;
    }

    logger.success(`Security PASSED (risk score: ${security.riskScore}/100)`);
    logger.info(`  Liquidity: $${security.liquidity.toFixed(0)}`);
    logger.info(`  Tax: buy=${security.buyTax}% sell=${security.sellTax}%`);
    logger.info(`  Verified: ${security.isVerified}`);
    logger.info(`  Top10 concentration: ${security.concentrationPct.toFixed(1)}%`);

    // ── Compute trade amount ──────────────────────────────────
    const amountInWei = await positionManager.computeTradeAmount(httpProvider, signer.address);
    if (!amountInWei) {
      logger.warn(`Insufficient balance to trade. Skipping.`);
      return;
    }

    logger.trade(`Trade amount: ${ethers.formatEther(amountInWei)} ETH`);

    // ── Get entry price (on-chain) ────────────────────────────
    const entryPrice = await getTokenPrice(httpProvider, tokenAddress, pairAddress, dex);
    if (!entryPrice || entryPrice === 0) {
      logger.warn(`Could not fetch entry price. Skipping.`);
      return;
    }

    logger.trade(`Entry price: $${entryPrice.toFixed(8)}`);

    // ── Execute Buy ───────────────────────────────────────────
    const buyResult = await executeBuy({
      signer,
      provider: httpProvider,
      tokenAddress,
      dex,
      amountInWei,
      fee: fee ?? 3000,
      stable: stable ?? false,
    });

    if (!buyResult.success) {
      logger.error(`Buy failed: ${buyResult.error}`);
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
      fee: fee ?? 3000,
      stable: stable ?? false,
    });

    positionManager.add(position);

    logger.success(`\nPosition #${position.id} opened!`);
    logger.success(`  Token: ${buyResult.name} (${buyResult.symbol})`);
    logger.success(`  ETH in: ${ethers.formatEther(amountInWei)}`);
    logger.success(`  Tokens received: ${ethers.formatUnits(buyResult.tokenAmount, buyResult.tokenDecimals)}`);
    logger.success(`  Entry price: $${entryPrice.toFixed(8)}`);
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
║         BASE NETWORK SNIPER BOT v1.1             ║
║   Uniswap V3 + Aerodrome | ethers.js v6          ║
╚═══════════════════════════════════════════════════╝
`);

  logger.info(`Configuration:`);
  logger.info(`  RPC HTTP : ${config.rpcHttp.slice(0, 45)}...`);
  logger.info(`  Max pos  : ${(config.maxPositionSizePct * 100).toFixed(0)}% per trade, ${config.maxOpenPositions} max open`);
  logger.info(`  Slippage : ${config.slippagePct}%  |  SL: ${config.slPct}%  |  Trailing: ${config.trailingDistancePct}%`);
  logger.info(`  TP levels: +${config.tp1Pct}% → sell ${config.tp1SellPct}% | +${config.tp2Pct}% → sell ${config.tp2SellPct}% | +${config.tp3Pct}% → sell ${config.tp3SellPct}%`);
  logger.info(`  Security : liq≥$${config.minLiquidityUsd}, tax≤${config.maxTaxPct}%, risk<${config.maxRiskScore}`);

  createProviders();

  // Check wallet balance
  const balance = await httpProvider.getBalance(signer.address);
  logger.info(`Wallet balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    logger.warn(`WARNING: Wallet has 0 ETH — trades will fail until funded.`);
  }

  // Start scanner (WebSocket)
  startScanner(wsProvider, handleNewPair);

  // Start monitoring loop (HTTP, every 5s)
  startMonitor(httpProvider, signer, positionManager);

  // WebSocket keepalive + reconnect every 30s
  setInterval(async () => {
    try {
      await wsProvider.getBlockNumber();
    } catch {
      await reconnectWs();
    }
  }, 30_000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.warn(`Shutting down...`);
    const open = positionManager.getAll();
    if (open.length > 0) {
      logger.warn(`WARNING: ${open.length} open position(s) NOT auto-sold on exit:`);
      open.forEach((p) => logger.warn(`  #${p.id} ${p.symbol} | ${p.tokenAddress}`));
    }
    process.exit(0);
  });

  logger.success(`Bot running. Listening for new pairs on Base...\n`);
}

main().catch((e) => {
  logger.error(`Fatal error: ${e.message}`);
  process.exit(1);
});
