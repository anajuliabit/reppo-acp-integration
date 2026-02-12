import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  decodeEventLog,
  encodeFunctionData,
  type Hash,
  type Address,
  type TransactionReceipt,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  POD_CONTRACT,
  REPPO_TOKEN,
  POD_ABI,
  ERC20_ABI,
  EMISSION_SHARE,
  TX_RECEIPT_TIMEOUT,
} from './constants.js';
import { withRetry, isRetryableError } from './lib/http.js';
import { createLogger } from './lib/logger.js';
import type { Clients, MintResult } from './types.js';

const log = createLogger('chain');

export function createClients(privateKey: string, rpcUrl?: string): Clients {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const transport = rpcUrl ? http(rpcUrl) : http();
  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ account, chain: base, transport });
  return { account, publicClient, walletClient } as Clients;
}

export function setAaClient(clients: Clients, contractClient: Clients['contractClient'], aaWalletAddress: `0x${string}`): void {
  clients.contractClient = contractClient;
  clients.aaWalletAddress = aaWalletAddress;
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

export function extractPodId(receipt: TransactionReceipt): bigint | undefined {
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
  const { account, publicClient, walletClient, contractClient, aaWalletAddress } = clients;
  const useAA = contractClient && aaWalletAddress;

  const fee = await getPublishingFee(clients);
  log.info({ fee: formatUnits(fee, 18), useAA }, 'Publishing fee');

  if (fee > 0n) {
    // Check REPPO balance on the address that will pay (AA or EOA)
    const payerAddress = aaWalletAddress ?? account.address;
    const reppoBalance = await getReppoBalance(clients, payerAddress);
    if (reppoBalance < fee) {
      throw new Error(
        `Insufficient REPPO. Need ${formatUnits(fee, 18)}, have ${formatUnits(reppoBalance, 18)}. ` +
        `Please fund ${payerAddress} with REPPO tokens.`
      );
    }
    log.info({ balance: formatUnits(reppoBalance, 18), payer: payerAddress }, 'REPPO balance sufficient');

    // Approve REPPO spend for minting
    const allowance = await getAllowance(clients, payerAddress);
    if (allowance < fee) {
      log.info({ useAA }, 'Approving REPPO spend...');

      if (useAA) {
        // Use AA execution via sessionKeyClient (covered by Alchemy paymaster)
        const approveData = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [POD_CONTRACT, fee],
        });
        const aaClient = (contractClient as any).sessionKeyClient;
        await aaClient.sendTransaction({
          to: REPPO_TOKEN,
          data: approveData,
        });
        log.info('REPPO approved via AA');
      } else {
        // Direct EOA transaction
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
      }
    } else {
      log.info('Already approved');
    }
  }

  log.info({ useAA }, 'Minting pod on Base...');

  let mintTx: Hash;

  if (useAA) {
    // Use AA execution via sessionKeyClient (covered by Alchemy paymaster)
    const mintData = encodeFunctionData({
      abi: POD_ABI,
      functionName: 'mintPod',
      args: [aaWalletAddress, EMISSION_SHARE],
    });
    const aaClient = (contractClient as any).sessionKeyClient;
    mintTx = await aaClient.sendTransaction({
      to: POD_CONTRACT,
      data: mintData,
    }) as Hash;
    log.info({ tx: mintTx }, 'Mint tx submitted via AA');
  } else {
    // Direct EOA transaction
    mintTx = await withRetry(
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
  }

  const mintReceipt = await publicClient.waitForTransactionReceipt({
    hash: mintTx,
    timeout: TX_RECEIPT_TIMEOUT,
  });

  if (mintReceipt.status === 'reverted') {
    throw new Error(`Mint transaction reverted: ${mintTx}`);
  }

  const podId = extractPodId(mintReceipt);
  if (!podId) {
    throw new Error('Pod ID not found in mint receipt');
  }

  log.info({ tx: mintTx, block: mintReceipt.blockNumber, podId }, 'Pod minted!');
  return { txHash: mintTx, receipt: mintReceipt, podId };
}
