import { ethers } from 'ethers';
import axios from 'axios';
import { UNISWAP_V3_POOL_ABI, AERODROME_PAIR_ABI } from './abis.js';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Get current price of a token in USD from DexScreener.
 * Returns null if unavailable.
 */
export async function getPriceFromDexScreener(tokenAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    const res = await axios.get(url, { timeout: 5000 });
    const pairs = res.data?.pairs?.filter((p) => p.chainId === 'base') ?? [];
    if (!pairs.length) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    return parseFloat(best.priceUsd ?? 0);
  } catch {
    return null;
  }
}

/**
 * Get price from Uniswap V3 pool via slot0 (sqrtPriceX96).
 * Returns price of token1 in terms of token0.
 */
export async function getPriceFromUniswapV3Pool(provider, poolAddress, tokenAddress) {
  try {
    const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);
    const [slot0, token0Addr, token1Addr] = await Promise.all([
      pool.slot0(),
      pool.token0(),
      pool.token1(),
    ]);

    const sqrtPriceX96 = slot0.sqrtPriceX96;
    // Price = (sqrtPriceX96 / 2^96)^2
    const priceRatio =
      (Number(sqrtPriceX96) / 2 ** 96) ** 2;

    const isToken0 = token0Addr.toLowerCase() === tokenAddress.toLowerCase();

    // If quoteToken is token0: price of token1 = priceRatio
    // If quoteToken is token1: price of token0 = 1/priceRatio
    return isToken0 ? 1 / priceRatio : priceRatio;
  } catch (e) {
    logger.error(`getPriceFromUniswapV3Pool error: ${e.message}`);
    return null;
  }
}

/**
 * Get price from Aerodrome pair via getReserves.
 */
export async function getPriceFromAerodromePair(provider, pairAddress, tokenAddress) {
  try {
    const pair = new ethers.Contract(pairAddress, AERODROME_PAIR_ABI, provider);
    const [reserves, token0Addr] = await Promise.all([
      pair.getReserves(),
      pair.token0(),
    ]);

    const [reserve0, reserve1] = [reserves[0], reserves[1]];
    const isToken0 = token0Addr.toLowerCase() === tokenAddress.toLowerCase();

    if (isToken0) {
      // price of token0 in token1 = reserve1 / reserve0
      return Number(reserve1) / Number(reserve0);
    } else {
      // price of token1 in token0 = reserve0 / reserve1
      return Number(reserve0) / Number(reserve1);
    }
  } catch (e) {
    logger.error(`getPriceFromAerodromePair error: ${e.message}`);
    return null;
  }
}

/**
 * Unified price fetcher: tries on-chain first, falls back to DexScreener.
 */
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
