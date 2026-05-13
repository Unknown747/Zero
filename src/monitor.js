import { ethers } from 'ethers';
import { config } from './config.js';
import { logger } from './logger.js';
import { getTokenPrice } from './price.js';
import { executeSell } from './trade.js';

/**
 * Start the monitoring loop.
 * Runs every MONITOR_INTERVAL_MS and checks all open positions for TP/SL conditions.
 */
export function startMonitor(provider, signer, positionManager) {
  logger.info(`Monitor started (interval: ${config.monitorIntervalMs}ms)`);

  let emptyLogCount = 0;

  const loop = async () => {
    const positions = positionManager.getAll();

    if (positions.length === 0) {
      // Log "no positions" only every 12 cycles (~1 minute at 5s interval) to reduce noise
      emptyLogCount++;
      if (emptyLogCount % 12 === 1) {
        logger.monitor(`No open positions. Watching for new pairs...`);
      }
      return;
    }

    emptyLogCount = 0;

    for (const position of positions) {
      try {
        const currentPrice = await getTokenPrice(
          provider,
          position.tokenAddress,
          position.pairAddress,
          position.dex
        );

        if (!currentPrice || currentPrice === 0) {
          logger.warn(`[Monitor] Could not fetch price for #${position.id} (${position.symbol})`);
          continue;
        }

        logger.monitor(position.summary(currentPrice));

        const action = positionManager.evaluateConditions(position, currentPrice);
        if (!action) continue;

        logger.trade(
          `[Position #${position.id}] ${action.type} triggered! Selling ${action.sellPct}% of remaining tokens`
        );

        // Calculate exact tokens to sell using BigInt arithmetic
        const tokensToSell = action.sellAll
          ? position.remainingTokens
          : (position.remainingTokens * BigInt(Math.round(action.sellPct))) / 100n;

        if (tokensToSell === 0n) {
          logger.warn(`[Position #${position.id}] Sell amount computed as 0, skipping`);
          continue;
        }

        const sellResult = await executeSell({
          signer,
          provider,
          tokenAddress: position.tokenAddress,
          dex: position.dex,
          amountTokens: tokensToSell,
          fee: position.fee,
          stable: position.stable,
        });

        if (sellResult.success) {
          logger.success(`[Position #${position.id}] ${action.type} sell executed successfully`);

          if (action.sellAll) {
            positionManager.remove(position.id);
          } else {
            position.remainingTokens -= tokensToSell;
            logger.trade(
              `[Position #${position.id}] Remaining: ${ethers.formatUnits(position.remainingTokens, position.tokenDecimals)} ${position.symbol}`
            );
          }
        } else {
          logger.error(`[Position #${position.id}] Sell FAILED: ${sellResult.error}`);
        }
      } catch (e) {
        logger.error(`[Monitor] Error processing position #${position.id}: ${e.message}`);
      }
    }
  };

  // Run immediately then on interval
  loop();
  return setInterval(loop, config.monitorIntervalMs);
}
