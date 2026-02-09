import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  decodeEventLog,
  encodeFunctionData,
  type Address,
  type TransactionReceipt,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  POD_CONTRACT,
  REPPO_TOKEN,
  USDC_TOKEN,
  UNISWAP_ROUTER,
  UNISWAP_QUOTER,
  POD_ABI,
  ERC20_ABI,
  SWAP_ROUTER_ABI,
  QUOTER_ABI,
  EMISSION_SHARE,
  TX_RECEIPT_TIMEOUT,
  SWAP_SLIPPAGE_BPS,
  SWAP_DEADLINE_SECONDS,
  POOL_FEE_TIERS,
} from './constants.js';
import { withRetry, isRetryableError } from './lib/http.js';
import { createLogger } from './lib/logger.js';
import type { Clients, MintResult } from './types.js';

const log = createLogger('chain');

export function createClients(privateKey: string, rpcUrl?: string): Clients {
  const account = privateKeyToAccount(
    privateKey.startsWith('0x') ? (privateKey as `0x${string}`) : `0x${privateKey}`,
  );
  const transport = rpcUrl ? http(rpcUrl) : http();
  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ account, chain: base, transport });
  return { account, publicClient, walletClient } as Clients;
}

export async function getPublishingFee(clients: Clients): Promise<bigint> {
  return withRetry(
    async () =>
      (await clients.publicClient.readContract({
        address: POD_CONTRACT,
        abi: POD_ABI,
        functionName: 'publishingFee',
      })) as bigint,
    'getPublishingFee',
    { shouldRetry: isRetryableError },
  );
}

export async function getReppoBalance(clients: Clients, address: Address): Promise<bigint> {
  return withRetry(
    async () =>
      (await clients.publicClient.readContract({
        address: REPPO_TOKEN,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
      })) as bigint,
    'getReppoBalance',
    { shouldRetry: isRetryableError },
  );
}

export async function getAllowance(clients: Clients, owner: Address): Promise<bigint> {
  return withRetry(
    async () =>
      (await clients.publicClient.readContract({
        address: REPPO_TOKEN,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [owner, POD_CONTRACT],
      })) as bigint,
    'getAllowance',
    { shouldRetry: isRetryableError },
  );
}

export async function getUsdcBalance(clients: Clients, address: Address): Promise<bigint> {
  return withRetry(
    async () =>
      (await clients.publicClient.readContract({
        address: USDC_TOKEN,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
      })) as bigint,
    'getUsdcBalance',
    { shouldRetry: isRetryableError },
  );
}

export async function getUsdcAllowance(clients: Clients, owner: Address): Promise<bigint> {
  return withRetry(
    async () =>
      (await clients.publicClient.readContract({
        address: USDC_TOKEN,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [owner, UNISWAP_ROUTER],
      })) as bigint,
    'getUsdcAllowance',
    { shouldRetry: isRetryableError },
  );
}

/**
 * Get a quote for swapping USDC to exact amount of REPPO
 * Tries multiple pool fee tiers to find one that works
 */
export async function getSwapQuote(
  clients: Clients,
  amountOut: bigint,
): Promise<{ amountIn: bigint; fee: number }> {
  for (const fee of POOL_FEE_TIERS) {
    try {
      const result = await clients.publicClient.readContract({
        address: UNISWAP_QUOTER,
        abi: QUOTER_ABI,
        functionName: 'quoteExactOutputSingle',
        args: [{
          tokenIn: USDC_TOKEN,
          tokenOut: REPPO_TOKEN,
          amount: amountOut,
          fee,
          sqrtPriceLimitX96: 0n,
        }],
      }) as [bigint, bigint, number, bigint];
      
      const amountIn = result[0];
      log.info({ fee, amountIn: formatUnits(amountIn, 6), amountOut: formatUnits(amountOut, 18) }, 'Got swap quote');
      return { amountIn, fee };
    } catch (err) {
      log.debug({ fee, error: (err as Error).message }, 'Quote failed for fee tier, trying next');
    }
  }
  
  throw new Error('No liquidity found for USDC/REPPO swap in any fee tier');
}

/**
 * Swap USDC → REPPO to cover publishing fee.
 * Uses Uniswap V3 exactOutputSingle with proper deadline via multicall.
 */
export async function swapUsdcToReppo(
  clients: Clients,
  amountOut: bigint,
): Promise<{ txHash: `0x${string}`; amountIn: bigint }> {
  const { account, publicClient, walletClient } = clients;

  // Get quote to determine actual USDC needed + correct pool fee
  const quote = await getSwapQuote(clients, amountOut);
  
  // Add slippage buffer
  const amountInWithSlippage = quote.amountIn + (quote.amountIn * BigInt(SWAP_SLIPPAGE_BPS) / 10000n);
  
  log.info({
    amountOut: formatUnits(amountOut, 18),
    quotedIn: formatUnits(quote.amountIn, 6),
    maxIn: formatUnits(amountInWithSlippage, 6),
    fee: quote.fee,
  }, 'Preparing swap');

  // Check USDC balance
  const usdcBalance = await getUsdcBalance(clients, account.address);
  log.info({ balance: formatUnits(usdcBalance, 6), needed: formatUnits(amountInWithSlippage, 6) }, 'USDC balance');
  
  if (usdcBalance < amountInWithSlippage) {
    throw new Error(
      `Insufficient USDC for swap. Need up to ${formatUnits(amountInWithSlippage, 6)}, have ${formatUnits(usdcBalance, 6)}`,
    );
  }

  // Approve USDC spend to router if needed
  const allowance = await getUsdcAllowance(clients, account.address);
  if (allowance < amountInWithSlippage) {
    log.info('Approving USDC spend for swap...');
    const approveTx = await withRetry(
      () => walletClient.writeContract({
        address: USDC_TOKEN,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [UNISWAP_ROUTER, amountInWithSlippage],
        chain: base,
        account,
      }),
      'approveUSDC',
      { shouldRetry: isRetryableError },
    );
    const approveReceipt = await publicClient.waitForTransactionReceipt({
      hash: approveTx,
      timeout: TX_RECEIPT_TIMEOUT,
    });
    if (approveReceipt.status === 'reverted') {
      throw new Error(`USDC approval reverted: ${approveTx}`);
    }
    log.info({ tx: approveTx }, 'USDC approved');
  }

  // Build swap calldata
  const swapData = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactOutputSingle',
    args: [{
      tokenIn: USDC_TOKEN,
      tokenOut: REPPO_TOKEN,
      fee: quote.fee,
      recipient: account.address,
      amountOut,
      amountInMaximum: amountInWithSlippage,
      sqrtPriceLimitX96: 0n,
    }],
  });

  // Execute swap via multicall with deadline
  const deadline = BigInt(Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS);
  
  log.info({ deadline: new Date(Number(deadline) * 1000).toISOString() }, 'Executing swap with deadline...');
  const swapTx = await withRetry(
    () => walletClient.writeContract({
      address: UNISWAP_ROUTER,
      abi: SWAP_ROUTER_ABI,
      functionName: 'multicall',
      args: [deadline, [swapData]],
      chain: base,
      account,
    }),
    'swapUsdcToReppo',
    { shouldRetry: isRetryableError },
  );

  const swapReceipt = await publicClient.waitForTransactionReceipt({
    hash: swapTx,
    timeout: TX_RECEIPT_TIMEOUT,
  });

  if (swapReceipt.status === 'reverted') {
    throw new Error(`Swap reverted: ${swapTx}`);
  }

  log.info({ tx: swapTx }, 'Swap complete');
  return { txHash: swapTx, amountIn: quote.amountIn };
}

/**
 * Ensure we have enough REPPO for the publishing fee, swapping USDC if needed.
 */
export async function ensureReppoBalance(clients: Clients, feeNeeded: bigint): Promise<void> {
  const balance = await getReppoBalance(clients, clients.account.address);
  log.info({
    balance: formatUnits(balance, 18),
    needed: formatUnits(feeNeeded, 18),
  }, 'Checking REPPO balance');

  if (balance >= feeNeeded) {
    log.info('Sufficient REPPO balance');
    return;
  }

  const shortfall = feeNeeded - balance;
  log.info({ shortfall: formatUnits(shortfall, 18) }, 'Need to swap for more REPPO');

  await swapUsdcToReppo(clients, shortfall);
  
  // Verify balance after swap
  const newBalance = await getReppoBalance(clients, clients.account.address);
  if (newBalance < feeNeeded) {
    throw new Error(`Swap completed but still insufficient REPPO. Have ${formatUnits(newBalance, 18)}, need ${formatUnits(feeNeeded, 18)}`);
  }
}

function extractPodId(receipt: TransactionReceipt): bigint | undefined {
  for (const log of receipt.logs) {
    try {
      const event = decodeEventLog({
        abi: POD_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (event.eventName === 'Transfer') {
        return (event.args as { tokenId: bigint }).tokenId;
      }
    } catch {
      // Not a matching event
    }
  }
  return undefined;
}

export async function mintPod(clients: Clients): Promise<MintResult> {
  const { account, publicClient, walletClient } = clients;

  const fee = await getPublishingFee(clients);
  log.info({ fee: formatUnits(fee, 18) }, 'Publishing fee');

  if (fee > 0n) {
    // Ensure we have enough REPPO (swap USDC if needed)
    await ensureReppoBalance(clients, fee);

    // Approve REPPO spend for minting
    const allowance = await getAllowance(clients, account.address);
    if (allowance < fee) {
      log.info('Approving REPPO spend...');
      const approveTx = await withRetry(
        () => walletClient.writeContract({
          address: REPPO_TOKEN,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [POD_CONTRACT, fee],
          chain: base,
          account,
        }),
        'approveREPPO',
        { shouldRetry: isRetryableError },
      );
      log.info({ tx: approveTx }, 'Approve tx submitted');
      const approveReceipt = await publicClient.waitForTransactionReceipt({
        hash: approveTx,
        timeout: TX_RECEIPT_TIMEOUT,
      });
      if (approveReceipt.status === 'reverted') {
        throw new Error(`Approval transaction reverted: ${approveTx}`);
      }
      log.info('REPPO approved');
    } else {
      log.info('Already approved');
    }
  }

  log.info('Minting pod on Base...');
  const mintTx = await withRetry(
    () => walletClient.writeContract({
      address: POD_CONTRACT,
      abi: POD_ABI,
      functionName: 'mintPod',
      args: [account.address, EMISSION_SHARE],
      chain: base,
      account,
    }),
    'mintPod',
    { shouldRetry: isRetryableError },
  );
  log.info({ tx: mintTx }, 'Mint tx submitted');

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: mintTx,
    timeout: TX_RECEIPT_TIMEOUT,
  });

  if (receipt.status === 'reverted') {
    throw new Error(`Mint transaction reverted: ${mintTx}`);
  }

  const podId = extractPodId(receipt);
  log.info({ block: receipt.blockNumber, podId: podId?.toString() }, 'Pod minted!');

  return { txHash: mintTx, receipt, podId };
}
