import { ethers } from 'ethers';
import axios from 'axios';
import { UNISWAP_V3_POOL_ABI, AERODROME_PAIR_ABI, ERC20_ABI } from './abis.js';
import { logger } from './logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getDecimals(provider, tokenAddress) {
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return Number(await token.decimals());
  } catch {
    return 18; // default to 18 if call fails
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DexScreener (USD, decimal-adjusted — most reliable after first ~30s)
// ─────────────────────────────────────────────────────────────────────────────

export async function getPriceFromDexScreener(tokenAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    const res = await axios.get(url, { timeout: 5000 });
    const pairs = res.data?.pairs?.filter((p) => p.chainId === 'base') ?? [];
    if (!pairs.length) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const price = parseFloat(best.priceUsd ?? 0);
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Uniswap V3 — sqrtPriceX96 → USD price with proper BigInt math + decimals
// ─────────────────────────────────────────────────────────────────────────────

export async function getPriceFromUniswapV3Pool(provider, poolAddress, tokenAddress) {
  try {
    const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);
    const [slot0Data, token0Addr, token1Addr] = await Promise.all([
      pool.slot0(),
      pool.token0(),
      pool.token1(),
    ]);

    const sqrtPriceX96 = slot0Data.sqrtPriceX96; // BigInt
    if (sqrtPriceX96 === 0n) return null;

    const [decimals0, decimals1] = await Promise.all([
      getDecimals(provider, token0Addr),
      getDecimals(provider, token1Addr),
    ]);

    // sqrtPriceX96 encodes: sqrt(price_of_token0_in_token1) * 2^96
    // price_of_token0_in_token1 (raw, no decimal adj) = (sqrtPriceX96)^2 / 2^192
    //
    // Decimal-adjusted price of token0 in token1:
    //   = rawPrice * 10^decimals0 / 10^decimals1
    //
    // We compute using BigInt scaled to 1e18 to preserve precision:
    const SCALE = 10n ** 18n;
    const Q192 = 2n ** 192n;

    // rawPrice_scaled = sqrtPriceX96^2 * SCALE / Q192
    // then decimal adjust: multiply by 10^d0, divide by 10^d1
    const rawPriceScaled = (sqrtPriceX96 * sqrtPriceX96 * SCALE) / Q192;

    let priceScaled;
    if (decimals0 >= decimals1) {
      priceScaled = rawPriceScaled * 10n ** BigInt(decimals0 - decimals1);
    } else {
      priceScaled = rawPriceScaled / 10n ** BigInt(decimals1 - decimals0);
    }

    // priceScaled is price of token0 in token1, scaled by 1e18
    const priceToken0InToken1 = Number(priceScaled) / 1e18;

    const isToken0 = token0Addr.toLowerCase() === tokenAddress.toLowerCase();

    // Return price of our target token in the other token (USDC equivalent)
    if (isToken0) {
      // Our token is token0; price in token1
      return priceToken0InToken1 > 0 ? priceToken0InToken1 : null;
    } else {
      // Our token is token1; price in token0 = 1 / priceToken0InToken1
      return priceToken0InToken1 > 0 ? 1 / priceToken0InToken1 : null;
    }
  } catch (e) {
    logger.error(`getPriceFromUniswapV3Pool error: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aerodrome — reserves → price with decimal adjustment
// ─────────────────────────────────────────────────────────────────────────────

export async function getPriceFromAerodromePair(provider, pairAddress, tokenAddress) {
  try {
    const pair = new ethers.Contract(pairAddress, AERODROME_PAIR_ABI, provider);
    const [reserves, token0Addr, token1Addr] = await Promise.all([
      pair.getReserves(),
      pair.token0(),
      pair.token1(),
    ]);

    const reserve0 = reserves[0]; // BigInt
    const reserve1 = reserves[1]; // BigInt

    if (reserve0 === 0n || reserve1 === 0n) return null;

    const [decimals0, decimals1] = await Promise.all([
      getDecimals(provider, token0Addr),
      getDecimals(provider, token1Addr),
    ]);

    // Decimal-adjusted price of token0 in token1:
    // = (reserve1 / reserve0) * (10^decimals0 / 10^decimals1)
    // = (reserve1 * 10^decimals0) / (reserve0 * 10^decimals1)
    //
    // Use BigInt scaled to 1e18 for precision:
    const SCALE = 10n ** 18n;
    const dec0 = 10n ** BigInt(decimals0);
    const dec1 = 10n ** BigInt(decimals1);

    const priceToken0InToken1Scaled = (reserve1 * SCALE * dec0) / (reserve0 * dec1);
    const priceToken0InToken1 = Number(priceToken0InToken1Scaled) / 1e18;

    const isToken0 = token0Addr.toLowerCase() === tokenAddress.toLowerCase();

    if (isToken0) {
      return priceToken0InToken1 > 0 ? priceToken0InToken1 : null;
    } else {
      return priceToken0InToken1 > 0 ? 1 / priceToken0InToken1 : null;
    }
  } catch (e) {
    logger.error(`getPriceFromAerodromePair error: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified price fetcher
// On-chain is tried first (new tokens won't be on DexScreener immediately).
// DexScreener is the fallback and becomes the primary source after ~30–60s.
// ─────────────────────────────────────────────────────────────────────────────

export async function getTokenPrice(provider, tokenAddress, pairAddress, dex) {
  let price = null;

  if (dex === 'uniswapV3') {
    price = await getPriceFromUniswapV3Pool(provider, pairAddress, tokenAddress);
  } else if (dex === 'aerodrome') {
    price = await getPriceFromAerodromePair(provider, pairAddress, tokenAddress);
  }

  if (!price) {
    price = await getPriceFromDexScreener(tokenAddress);
  }

  return price;
}
