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
  POD_ABI,
  ERC20_ABI,
  EMISSION_SHARE,
  TX_RECEIPT_TIMEOUT,
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
    const balance = await getReppoBalance(clients, account.address);
    console.log(`REPPO balance: ${formatUnits(balance, 18)}`);
    if (balance < fee) {
      throw new Error(
        `Insufficient REPPO balance. Need ${formatUnits(fee, 18)}, have ${formatUnits(balance, 18)}`,
      );
    }

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
