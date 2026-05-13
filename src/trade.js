import { ethers } from 'ethers';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  UNISWAP_V3_ROUTER_ABI,
  AERODROME_ROUTER_ABI,
  ERC20_ABI,
} from './abis.js';

function deadline() {
  return Math.floor(Date.now() / 1000) + 300; // 5 minutes from now
}

async function getGasOverrides(provider) {
  const overrides = { gasLimit: config.gasLimit };
  if (config.gasPriceGwei > 0) {
    overrides.gasPrice = ethers.parseUnits(String(config.gasPriceGwei), 'gwei');
  } else {
    const feeData = await provider.getFeeData();
    overrides.gasPrice = feeData.gasPrice;
  }
  return overrides;
}

async function ensureApproval(signer, tokenAddress, spender, amount) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const owner = await signer.getAddress();
  const allowance = await token.allowance(owner, spender);
  if (allowance < amount) {
    logger.trade(`Approving ${spender} to spend tokens...`);
    const tx = await token.approve(spender, ethers.MaxUint256);
    await tx.wait();
    logger.trade(`Approval confirmed`);
  }
}

// ─────────────────────────────────────────────
// BUY via Uniswap V3 (SwapRouter02 on Base)
// tokenIn = WETH + msg.value → router auto-wraps ETH
// ─────────────────────────────────────────────
async function buyViaUniswapV3(signer, provider, tokenAddress, amountInWei, fee) {
  const router = new ethers.Contract(config.uniswapV3Router, UNISWAP_V3_ROUTER_ABI, signer);

  const params = {
    tokenIn: config.WETH,
    tokenOut: tokenAddress,
    fee,
    recipient: await signer.getAddress(),
    deadline: deadline(),
    amountIn: amountInWei,
    amountOutMinimum: 0n, // sniper mode — accept any output
    sqrtPriceLimitX96: 0n,
  };

  const overrides = await getGasOverrides(provider);
  overrides.value = amountInWei;

  logger.trade(`Buying via Uniswap V3: ${ethers.formatEther(amountInWei)} ETH → ${tokenAddress} (fee: ${fee})`);
  const tx = await router.exactInputSingle(params, overrides);
  logger.trade(`Buy TX sent: ${tx.hash}`);
  const receipt = await tx.wait();
  logger.trade(`Buy confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

// ─────────────────────────────────────────────
// BUY via Aerodrome
// ─────────────────────────────────────────────
async function buyViaAerodrome(signer, provider, tokenAddress, amountInWei, stable) {
  const router = new ethers.Contract(config.aerodromeRouter, AERODROME_ROUTER_ABI, signer);

  const routes = [
    {
      from: config.WETH,
      to: tokenAddress,
      stable,
      factory: config.aerodromeFactory,
    },
  ];

  const overrides = await getGasOverrides(provider);
  overrides.value = amountInWei;

  logger.trade(`Buying via Aerodrome: ${ethers.formatEther(amountInWei)} ETH → ${tokenAddress} (stable: ${stable})`);
  const tx = await router.swapExactETHForTokens(
    0n, // amountOutMin = 0 (sniper mode)
    routes,
    await signer.getAddress(),
    deadline(),
    overrides
  );
  logger.trade(`Buy TX sent: ${tx.hash}`);
  const receipt = await tx.wait();
  logger.trade(`Buy confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

// ─────────────────────────────────────────────
// SELL via Uniswap V3
// ─────────────────────────────────────────────
async function sellViaUniswapV3(signer, provider, tokenAddress, amountTokens, fee) {
  await ensureApproval(signer, tokenAddress, config.uniswapV3Router, amountTokens);

  const router = new ethers.Contract(config.uniswapV3Router, UNISWAP_V3_ROUTER_ABI, signer);
  const params = {
    tokenIn: tokenAddress,
    tokenOut: config.WETH,
    fee,
    recipient: await signer.getAddress(),
    deadline: deadline(),
    amountIn: amountTokens,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  };

  const overrides = await getGasOverrides(provider);
  logger.trade(`Selling via Uniswap V3: ${amountTokens} tokens → ETH (fee: ${fee})`);
  const tx = await router.exactInputSingle(params, overrides);
  logger.trade(`Sell TX sent: ${tx.hash}`);
  const receipt = await tx.wait();
  logger.trade(`Sell confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

// ─────────────────────────────────────────────
// SELL via Aerodrome
// ─────────────────────────────────────────────
async function sellViaAerodrome(signer, provider, tokenAddress, amountTokens, stable) {
  await ensureApproval(signer, tokenAddress, config.aerodromeRouter, amountTokens);

  const router = new ethers.Contract(config.aerodromeRouter, AERODROME_ROUTER_ABI, signer);
  const routes = [
    {
      from: tokenAddress,
      to: config.WETH,
      stable,
      factory: config.aerodromeFactory,
    },
  ];

  const overrides = await getGasOverrides(provider);
  logger.trade(`Selling via Aerodrome: ${amountTokens} tokens → ETH (stable: ${stable})`);
  const tx = await router.swapExactTokensForETH(
    amountTokens,
    0n,
    routes,
    await signer.getAddress(),
    deadline(),
    overrides
  );
  logger.trade(`Sell TX sent: ${tx.hash}`);
  const receipt = await tx.wait();
  logger.trade(`Sell confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

// ─────────────────────────────────────────────
// EXECUTE BUY (public API)
// ─────────────────────────────────────────────
export async function executeBuy({
  signer,
  provider,
  tokenAddress,
  dex,
  amountInWei,
  fee = 3000,
  stable = false,
}) {
  try {
    let receipt;
    if (dex === 'uniswapV3') {
      receipt = await buyViaUniswapV3(signer, provider, tokenAddress, amountInWei, fee);
    } else {
      receipt = await buyViaAerodrome(signer, provider, tokenAddress, amountInWei, stable);
    }

    // Read token balance + metadata after buy
    const walletAddress = await signer.getAddress();
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [tokenBalance, decimals, symbol, name] = await Promise.all([
      token.balanceOf(walletAddress),
      token.decimals(),
      token.symbol(),
      token.name(),
    ]);

    logger.success(`Bought ${ethers.formatUnits(tokenBalance, decimals)} ${symbol}`);

    return {
      success: true,
      receipt,
      tokenAmount: tokenBalance,
      tokenDecimals: Number(decimals),
      symbol,
      name,
    };
  } catch (e) {
    logger.error(`executeBuy failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ─────────────────────────────────────────────
// EXECUTE SELL (public API)
// ─────────────────────────────────────────────
export async function executeSell({
  signer,
  provider,
  tokenAddress,
  dex,
  amountTokens,
  fee = 3000,
  stable = false,
}) {
  try {
    let receipt;
    if (dex === 'uniswapV3') {
      receipt = await sellViaUniswapV3(signer, provider, tokenAddress, amountTokens, fee);
    } else {
      receipt = await sellViaAerodrome(signer, provider, tokenAddress, amountTokens, stable);
    }

    return { success: true, receipt };
  } catch (e) {
    logger.error(`executeSell failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}
