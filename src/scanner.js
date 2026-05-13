import { ethers } from 'ethers';
import { config } from './config.js';
import { logger } from './logger.js';
import { UNISWAP_V3_FACTORY_ABI, AERODROME_FACTORY_ABI } from './abis.js';

const QUOTE_TOKEN = config.quoteToken.toLowerCase();

/**
 * Start the pair scanner.
 * Calls onNewPair({ tokenAddress, pairAddress, blockNumber, dex, fee?, stable? })
 * whenever a new pair involving the QUOTE_TOKEN is detected.
 *
 * In ethers v6, the last argument to a contract event listener is the EventLog object.
 * EventLog has .blockNumber, .transactionHash, etc. directly — not nested under .log.
 */
export function startScanner(wsProvider, onNewPair) {
  // ─── Uniswap V3 ───────────────────────────────────────────────────
  const uniV3Factory = new ethers.Contract(
    config.uniswapV3Factory,
    UNISWAP_V3_FACTORY_ABI,
    wsProvider
  );

  uniV3Factory.on('PoolCreated', (token0, token1, fee, tickSpacing, pool, event) => {
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();

    if (t0 !== QUOTE_TOKEN && t1 !== QUOTE_TOKEN) return;

    const tokenAddress = t0 === QUOTE_TOKEN ? token1 : token0;
    const pairAddress = pool;
    // ethers v6: last arg IS the EventLog — use event.blockNumber directly
    const blockNumber = event?.blockNumber ?? 0;

    logger.scan(
      `[Uniswap V3] New pool! Token: ${tokenAddress} | Pool: ${pairAddress} | Fee: ${fee} | Block: ${blockNumber}`
    );

    onNewPair({
      tokenAddress,
      pairAddress,
      blockNumber,
      dex: 'uniswapV3',
      fee: Number(fee),
    });
  });

  logger.info(`Listening to Uniswap V3 Factory (${config.uniswapV3Factory})...`);

  // ─── Aerodrome ─────────────────────────────────────────────────────
  const aerodromeFactory = new ethers.Contract(
    config.aerodromeFactory,
    AERODROME_FACTORY_ABI,
    wsProvider
  );

  aerodromeFactory.on('PairCreated', (token0, token1, stable, pair, arg4, event) => {
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();

    if (t0 !== QUOTE_TOKEN && t1 !== QUOTE_TOKEN) return;

    const tokenAddress = t0 === QUOTE_TOKEN ? token1 : token0;
    const pairAddress = pair;
    const blockNumber = event?.blockNumber ?? 0;

    logger.scan(
      `[Aerodrome] New pair! Token: ${tokenAddress} | Pair: ${pairAddress} | Stable: ${stable} | Block: ${blockNumber}`
    );

    onNewPair({
      tokenAddress,
      pairAddress,
      blockNumber,
      dex: 'aerodrome',
      stable: Boolean(stable),
    });
  });

  logger.info(`Listening to Aerodrome Factory (${config.aerodromeFactory})...`);
}
