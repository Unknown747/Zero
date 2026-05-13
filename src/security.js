import axios from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';

const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

async function safeGet(url, params = {}, timeout = 8000) {
  try {
    const res = await axios.get(url, { params, timeout });
    return res.data;
  } catch {
    return null;
  }
}

// A. Honeypot check via honeypot.is
async function checkHoneypot(tokenAddress) {
  const data = await safeGet('https://api.honeypot.is/v1/GetTokenInfo', {
    network: 'base',
    token: tokenAddress,
  });

  if (!data) {
    logger.security(`[Honeypot] No response for ${tokenAddress} — treating as safe`);
    return { isHoneypot: false, buyTax: 0, sellTax: 0 };
  }

  const isHoneypot = data?.honeypotResult?.isHoneypot === true;
  const buyTax = data?.simulationResult?.buyTax ?? 0;
  const sellTax = data?.simulationResult?.sellTax ?? 0;

  return { isHoneypot, buyTax, sellTax };
}

// C. Liquidity check via DexScreener
async function checkLiquidity(tokenAddress) {
  const data = await safeGet(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);

  if (!data || !data.pairs) return 0;

  const basePairs = data.pairs.filter(
    (p) => p.chainId === 'base' && p.liquidity?.usd
  );

  if (!basePairs.length) return 0;

  const best = basePairs.sort((a, b) => b.liquidity.usd - a.liquidity.usd)[0];
  return best.liquidity.usd ?? 0;
}

// D. Holder concentration check via BaseScan
async function checkHolderConcentration(tokenAddress) {
  const data = await safeGet('https://api.basescan.org/api', {
    module: 'token',
    action: 'tokenholderlist',
    contractaddress: tokenAddress,
    page: 1,
    offset: 20,
    apikey: config.basescanApiKey,
  });

  if (!data || data.status !== '1' || !Array.isArray(data.result)) {
    return { concentrationPct: 0, topHolders: [] };
  }

  // Filter out known burn addresses
  const allHolders = data.result.filter(
    (h) => !BURN_ADDRESSES.has(h.TokenHolderAddress.toLowerCase())
  );

  if (!allHolders.length) return { concentrationPct: 0, topHolders: [] };

  // Top 10 holders vs all returned holders (up to 20)
  const top10 = allHolders.slice(0, 10);

  const top10Supply = top10.reduce((acc, h) => acc + BigInt(h.TokenHolderQuantity), 0n);
  const allSupply = allHolders.reduce((acc, h) => acc + BigInt(h.TokenHolderQuantity), 0n);

  if (allSupply === 0n) return { concentrationPct: 0, topHolders: top10 };

  const concentrationPct = Number((top10Supply * 10000n) / allSupply) / 100;

  return { concentrationPct, topHolders: top10 };
}

// E. Contract verification check via BaseScan
async function checkContractVerified(tokenAddress) {
  const data = await safeGet('https://api.basescan.org/api', {
    module: 'contract',
    action: 'getsourcecode',
    address: tokenAddress,
    apikey: config.basescanApiKey,
  });

  if (!data || data.status !== '1' || !data.result?.[0]) return false;

  const sourceCode = data.result[0].SourceCode;
  return typeof sourceCode === 'string' && sourceCode.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main security check — runs all 5 layers in order
// ─────────────────────────────────────────────────────────────────────────────
export async function checkTokenSecurity(tokenAddress) {
  logger.security(`Running security checks for ${tokenAddress}...`);

  const result = {
    passed: false,
    riskScore: 0,
    reasons: [],
    buyTax: 0,
    sellTax: 0,
    liquidity: 0,
    concentrationPct: 0,
    isVerified: false,
  };

  // A. HONEYPOT CHECK (Critical — immediate reject)
  logger.security(`[1/5] Honeypot check...`);
  const { isHoneypot, buyTax, sellTax } = await checkHoneypot(tokenAddress);
  result.buyTax = buyTax;
  result.sellTax = sellTax;

  if (isHoneypot) {
    result.reasons.push('HONEYPOT DETECTED');
    logger.security(`REJECTED: Honeypot detected`);
    return result;
  }

  // B. TAX CHECK (>10% → immediate reject)
  logger.security(`[2/5] Tax check (buy=${buyTax}%, sell=${sellTax}%)...`);
  if (buyTax > config.maxTaxPct || sellTax > config.maxTaxPct) {
    result.reasons.push(`Tax too high (buy=${buyTax}%, sell=${sellTax}%)`);
    logger.security(`REJECTED: Tax too high`);
    return result;
  }

  // Risk score from tax
  const maxTax = Math.max(buyTax, sellTax);
  if (maxTax > 8) result.riskScore += 10;
  else if (maxTax > 5) result.riskScore += 5;

  // C. LIQUIDITY CHECK (<$5000 → immediate reject)
  logger.security(`[3/5] Liquidity check...`);
  const liquidity = await checkLiquidity(tokenAddress);
  result.liquidity = liquidity;

  if (liquidity < config.minLiquidityUsd) {
    result.reasons.push(`Liquidity too low: $${liquidity.toFixed(0)}`);
    logger.security(`REJECTED: Liquidity $${liquidity.toFixed(0)} < $${config.minLiquidityUsd}`);
    return result;
  }

  // D. HOLDER CONCENTRATION CHECK (top10 >30% → +25 risk)
  logger.security(`[4/5] Holder concentration check...`);
  const { concentrationPct } = await checkHolderConcentration(tokenAddress);
  result.concentrationPct = concentrationPct;

  if (concentrationPct > config.holderConcentrationThreshold) {
    result.riskScore += 25;
    result.reasons.push(`High holder concentration: ${concentrationPct.toFixed(1)}% in top 10`);
    logger.security(`WARNING: Top 10 holders own ${concentrationPct.toFixed(1)}% → +25 risk`);
  }

  // E. CONTRACT VERIFICATION (not verified → +15 risk)
  logger.security(`[5/5] Contract verification check...`);
  const isVerified = await checkContractVerified(tokenAddress);
  result.isVerified = isVerified;

  if (!isVerified) {
    result.riskScore += 15;
    result.reasons.push('Contract not verified on BaseScan');
    logger.security(`WARNING: Contract not verified → +15 risk`);
  }

  // F. FINAL RISK SCORE
  logger.security(
    `Final risk score: ${result.riskScore}/100 (threshold: <${config.maxRiskScore})`
  );

  if (result.riskScore < config.maxRiskScore) {
    result.passed = true;
  } else {
    result.reasons.push(`Risk score too high: ${result.riskScore}`);
  }

  return result;
}
