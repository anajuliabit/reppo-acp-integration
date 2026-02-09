import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  decodeEventLog,
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
  POD_ABI,
  ERC20_ABI,
  SWAP_ROUTER_ABI,
  EMISSION_SHARE,
  TX_RECEIPT_TIMEOUT,
  SWAP_SLIPPAGE_BPS,
} from './constants.js';
import { withRetry } from './lib/http.js';
import type { Clients, MintResult } from './types.js';

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
  );
}

/**
 * Swap USDC → REPPO to cover publishing fee.
 * Uses Uniswap V3 exactOutputSingle to get exact amount of REPPO needed.
 * @param clients - viem clients
 * @param amountOut - exact REPPO amount needed (18 decimals)
 * @param maxAmountIn - max USDC to spend (6 decimals), with slippage
 */
export async function swapUsdcToReppo(
  clients: Clients,
  amountOut: bigint,
  maxAmountIn: bigint,
): Promise<{ txHash: `0x${string}`; amountIn: bigint }> {
  const { account, publicClient, walletClient } = clients;

  // Check USDC balance
  const usdcBalance = await getUsdcBalance(clients, account.address);
  console.log(`USDC balance: ${formatUnits(usdcBalance, 6)}`);
  if (usdcBalance < maxAmountIn) {
    throw new Error(
      `Insufficient USDC for swap. Need up to ${formatUnits(maxAmountIn, 6)}, have ${formatUnits(usdcBalance, 6)}`,
    );
  }

  // Approve USDC spend to router if needed
  const allowance = await getUsdcAllowance(clients, account.address);
  if (allowance < maxAmountIn) {
    console.log('Approving USDC spend for swap...');
    const approveTx = await walletClient.writeContract({
      address: USDC_TOKEN,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [UNISWAP_ROUTER, maxAmountIn],
      chain: base,
      account,
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({
      hash: approveTx,
      timeout: TX_RECEIPT_TIMEOUT,
    });
    if (approveReceipt.status === 'reverted') {
      throw new Error(`USDC approval reverted: ${approveTx}`);
    }
    console.log('  USDC approved');
  }

  // Swap via exactOutputSingle
  // Pool fee: 3000 = 0.3% (common tier), try 10000 = 1% if low liquidity
  const poolFee = 3000;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min

  console.log(`Swapping USDC → REPPO (need ${formatUnits(amountOut, 18)} REPPO)...`);
  const swapTx = await walletClient.writeContract({
    address: UNISWAP_ROUTER,
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactOutputSingle',
    args: [
      {
        tokenIn: USDC_TOKEN,
        tokenOut: REPPO_TOKEN,
        fee: poolFee,
        recipient: account.address,
        amountOut,
        amountInMaximum: maxAmountIn,
        sqrtPriceLimitX96: 0n, // no price limit
      },
    ],
    chain: base,
    account,
  });

  const swapReceipt = await publicClient.waitForTransactionReceipt({
    hash: swapTx,
    timeout: TX_RECEIPT_TIMEOUT,
  });

  if (swapReceipt.status === 'reverted') {
    throw new Error(`Swap reverted: ${swapTx}`);
  }

  console.log(`  Swap complete: ${swapTx}`);
  return { txHash: swapTx, amountIn: maxAmountIn }; // Actual amountIn would need log parsing
}

/**
 * Ensure we have enough REPPO for the publishing fee, swapping USDC if needed.
 */
export async function ensureReppoBalance(clients: Clients, feeNeeded: bigint): Promise<void> {
  const balance = await getReppoBalance(clients, clients.account.address);
  console.log(`REPPO balance: ${formatUnits(balance, 18)}, need: ${formatUnits(feeNeeded, 18)}`);

  if (balance >= feeNeeded) {
    console.log('Sufficient REPPO balance');
    return;
  }

  const shortfall = feeNeeded - balance;
  console.log(`Need to swap for ${formatUnits(shortfall, 18)} more REPPO`);

  // Estimate USDC needed (rough: assume 1 REPPO ~ $0.01-$1, add slippage buffer)
  // This is a rough estimate - in production you'd use a quoter contract
  // For now, assume max 10 USDC per job (adjust based on actual REPPO price)
  const maxUsdcIn = 10_000_000n; // 10 USDC (6 decimals)

  await swapUsdcToReppo(clients, shortfall, maxUsdcIn);
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
  console.log(`Publishing fee: ${formatUnits(fee, 18)} REPPO`);

  if (fee > 0n) {
    // Ensure we have enough REPPO (swap USDC if needed)
    await ensureReppoBalance(clients, fee);

    // Approve REPPO spend for minting
    const allowance = await getAllowance(clients, account.address);
    if (allowance < fee) {
      console.log('Approving REPPO spend...');
      const approveTx = await walletClient.writeContract({
        address: REPPO_TOKEN,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [POD_CONTRACT, fee],
        chain: base,
        account,
      });
      console.log(`  Approve tx: ${approveTx}`);
      const approveReceipt = await publicClient.waitForTransactionReceipt({
        hash: approveTx,
        timeout: TX_RECEIPT_TIMEOUT,
      });
      if (approveReceipt.status === 'reverted') {
        throw new Error(`Approval transaction reverted: ${approveTx}`);
      }
      console.log('  Approved');
    } else {
      console.log('Already approved');
    }
  }

  console.log('Minting pod on Base...');
  const mintTx = await walletClient.writeContract({
    address: POD_CONTRACT,
    abi: POD_ABI,
    functionName: 'mintPod',
    args: [account.address, EMISSION_SHARE],
    chain: base,
    account,
  });
  console.log(`  Mint tx: ${mintTx}`);

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: mintTx,
    timeout: TX_RECEIPT_TIMEOUT,
  });

  if (receipt.status === 'reverted') {
    throw new Error(`Mint transaction reverted: ${mintTx}`);
  }

  const podId = extractPodId(receipt);
  console.log(`  Pod minted! Block: ${receipt.blockNumber}${podId !== undefined ? `, Pod ID: ${podId}` : ''}`);

  return { txHash: mintTx, receipt, podId };
}
