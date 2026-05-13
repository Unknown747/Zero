import { ethers } from 'ethers';
import { config } from './config.js';
import { logger } from './logger.js';

let positionIdCounter = 1;

export class Position {
  constructor({ tokenAddress, pairAddress, dex, entryPrice, amountIn, tokenAmount, tokenDecimals, symbol }) {
    this.id = positionIdCounter++;
    this.tokenAddress = tokenAddress;
    this.pairAddress = pairAddress;
    this.dex = dex; // 'uniswapV3' | 'aerodrome'
    this.entryPrice = entryPrice;           // price in USD or ETH per token
    this.amountIn = amountIn;               // ETH spent (BigInt wei)
    this.tokenAmount = tokenAmount;         // tokens received (BigInt)
    this.tokenDecimals = tokenDecimals;
    this.symbol = symbol;
    this.openedAt = Date.now();

    // TP tracking
    this.tp1Hit = false;
    this.tp2Hit = false;
    this.tp3Hit = false;

    // Trailing stop
    this.highestPrice = entryPrice;
    this.trailingActive = false;

    // Remaining token amount after partial sells
    this.remainingTokens = tokenAmount;
  }

  profitPct(currentPrice) {
    if (!this.entryPrice || this.entryPrice === 0) return 0;
    return ((currentPrice - this.entryPrice) / this.entryPrice) * 100;
  }

  updateHighestPrice(currentPrice) {
    if (currentPrice > this.highestPrice) {
      this.highestPrice = currentPrice;
    }
  }

  activateTrailing(currentPrice) {
    const profit = this.profitPct(currentPrice);
    if (!this.trailingActive && profit >= config.trailingActivatePct) {
      this.trailingActive = true;
      logger.monitor(`[Position #${this.id}] Trailing stop ACTIVATED at ${profit.toFixed(2)}% profit`);
    }
  }

  summary(currentPrice) {
    const profit = this.profitPct(currentPrice);
    const age = ((Date.now() - this.openedAt) / 1000 / 60).toFixed(1);
    return `[#${this.id} ${this.symbol}] Entry: ${this.entryPrice?.toFixed(8)} | Now: ${currentPrice?.toFixed(8)} | P&L: ${profit.toFixed(2)}% | Age: ${age}m | Trailing: ${this.trailingActive}`;
  }
}

export class PositionManager {
  constructor() {
    this.positions = new Map(); // id → Position
  }

  count() {
    return this.positions.size;
  }

  canOpenNew() {
    return this.positions.size < config.maxOpenPositions;
  }

  add(position) {
    this.positions.set(position.id, position);
    logger.trade(`Position #${position.id} opened for ${position.symbol}`);
  }

  remove(positionId) {
    this.positions.delete(positionId);
    logger.trade(`Position #${positionId} closed and removed`);
  }

  getAll() {
    return Array.from(this.positions.values());
  }

  get(positionId) {
    return this.positions.get(positionId);
  }

  /**
   * Compute the ETH amount to spend for a new trade.
   * Up to 40% of current wallet balance, but at least MIN_TRADE_ETH.
   */
  async computeTradeAmount(provider, walletAddress) {
    const balance = await provider.getBalance(walletAddress);
    const balanceEth = parseFloat(ethers.formatEther(balance));
    const targetEth = balanceEth * config.maxPositionSizePct;
    const minEth = parseFloat(config.minTradeEth);

    if (targetEth < minEth) {
      logger.warn(`Wallet balance too low for a trade (balance: ${balanceEth.toFixed(4)} ETH)`);
      return null;
    }

    return ethers.parseEther(targetEth.toFixed(6));
  }

  /**
   * Evaluate all TP/SL conditions for a position.
   * Returns a sell action if a condition is triggered.
   *
   * sellAction: {
   *   type: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'TRAILING' | 'TIME_EXIT',
   *   sellPct: number,  // 0-100 percent of remaining tokens
   *   sellAll: boolean
   * }
   */
  evaluateConditions(position, currentPrice) {
    const profit = position.profitPct(currentPrice);
    const ageHours = (Date.now() - position.openedAt) / 1000 / 3600;

    // Update trailing
    position.updateHighestPrice(currentPrice);
    position.activateTrailing(currentPrice);

    // --- HARD STOP LOSS ---
    const slTriggerPrice = position.entryPrice * (1 - config.slPct / 100);
    if (currentPrice <= slTriggerPrice) {
      return { type: 'SL', sellPct: 100, sellAll: true };
    }

    // --- TRAILING STOP ---
    if (position.trailingActive) {
      const trailingTrigger = position.highestPrice * (1 - config.trailingDistancePct / 100);
      if (currentPrice <= trailingTrigger) {
        return { type: 'TRAILING', sellPct: 100, sellAll: true };
      }
    }

    // --- TIME EXIT ---
    if (ageHours >= config.timeExitHours && profit < config.timeExitMinProfitPct) {
      return { type: 'TIME_EXIT', sellPct: 100, sellAll: true };
    }

    // --- TAKE PROFIT LEVELS ---
    if (!position.tp3Hit && profit >= config.tp3Pct) {
      position.tp3Hit = true;
      return { type: 'TP3', sellPct: config.tp3SellPct, sellAll: false };
    }

    if (!position.tp2Hit && profit >= config.tp2Pct) {
      position.tp2Hit = true;
      return { type: 'TP2', sellPct: config.tp2SellPct, sellAll: false };
    }

    if (!position.tp1Hit && profit >= config.tp1Pct) {
      position.tp1Hit = true;
      return { type: 'TP1', sellPct: config.tp1SellPct, sellAll: false };
    }

    return null;
  }
}
