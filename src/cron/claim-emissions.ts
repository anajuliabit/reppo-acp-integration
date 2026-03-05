import 'dotenv/config';
import { formatUnits, type Address } from 'viem';
import { base } from 'viem/chains';
import { createClients } from '../chain.js';
import { initPods, getUnclaimedPods, markPodClaimed } from '../lib/pods.js';
import { withRetry, isRetryableError } from '../lib/http.js';
import { createLogger } from '../lib/logger.js';
import {
  POD_CONTRACT,
  REPPO_TOKEN,
  POD_ABI,
  ERC20_ABI,
  EPOCH_DURATION,
  TX_RECEIPT_TIMEOUT,
} from '../constants.js';
import type { Clients } from '../types.js';

const log = createLogger('claim-emissions');
const dryRun = process.argv.includes('--dry-run');

async function getInitTimestamp(clients: Clients): Promise<bigint> {
  return withRetry(
    async () =>
      (await clients.publicClient.readContract({
        address: POD_CONTRACT,
        abi: POD_ABI,
        functionName: 'initialisedTimestamp',
      })) as bigint,
    'getInitTimestamp',
    { shouldRetry: isRetryableError },
  );
}

function getCurrentEpoch(initTimestamp: bigint): number {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const elapsed = now - initTimestamp;
  if (elapsed <= 0n) return 0;
  return Number(elapsed / BigInt(EPOCH_DURATION));
}

async function getPodEmissions(clients: Clients, podId: number, epoch: number): Promise<bigint> {
  return withRetry(
    async () =>
      (await clients.publicClient.readContract({
        address: POD_CONTRACT,
        abi: POD_ABI,
        functionName: 'getPodEmissionsOfEpoch',
        args: [BigInt(podId), BigInt(epoch)],
      })) as bigint,
    `getPodEmissions(${podId},${epoch})`,
    { shouldRetry: isRetryableError },
  );
}

async function hasClaimed(clients: Clients, podId: number, epoch: number): Promise<boolean> {
  return withRetry(
    async () =>
      (await clients.publicClient.readContract({
        address: POD_CONTRACT,
        abi: POD_ABI,
        functionName: 'hasPodOwnerClaimedEmissions',
        args: [BigInt(podId), BigInt(epoch)],
      })) as boolean,
    `hasClaimed(${podId},${epoch})`,
    { shouldRetry: isRetryableError },
  );
}

async function claimPodOwnerEmissions(clients: Clients, podId: number, epoch: number): Promise<string> {
  const { account, publicClient, walletClient } = clients;

  const tx = await withRetry(
    () => walletClient.writeContract({
      address: POD_CONTRACT,
      abi: POD_ABI,
      functionName: 'claimPodOwnerEmissions',
      args: [BigInt(podId), BigInt(epoch)],
      chain: base,
      account,
    }),
    `claimEmissions(${podId},${epoch})`,
    { shouldRetry: isRetryableError },
  );

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: tx,
    timeout: TX_RECEIPT_TIMEOUT,
  });

  if (receipt.status === 'reverted') {
    throw new Error(`Claim tx reverted: ${tx}`);
  }

  log.info({ podId, epoch, tx }, 'Emissions claimed on-chain');
  return tx;
}

async function transferReppo(clients: Clients, to: Address, amount: bigint): Promise<string> {
  const { account, publicClient, walletClient } = clients;

  const tx = await withRetry(
    () => walletClient.writeContract({
      address: REPPO_TOKEN,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [to, amount],
      chain: base,
      account,
    }),
    `transferReppo(${to})`,
    { shouldRetry: isRetryableError },
  );

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: tx,
    timeout: TX_RECEIPT_TIMEOUT,
  });

  if (receipt.status === 'reverted') {
    throw new Error(`Transfer tx reverted: ${tx}`);
  }

  log.info({ to, amount: formatUnits(amount, 18), tx }, 'REPPO transferred to buyer');
  return tx;
}

async function main() {
  log.info({ dryRun }, 'Starting emissions claim cron...');

  // Minimal config for this script
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;

  if (!privateKey) {
    log.fatal('PRIVATE_KEY env var is required');
    process.exit(1);
  }

  // Init DynamoDB
  initPods({
    DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT,
    AWS_REGION: process.env.AWS_REGION,
  });

  const clients = createClients(privateKey, rpcUrl);
  log.info({ wallet: clients.account.address }, 'Chain clients ready');

  const initTimestamp = await getInitTimestamp(clients);
  const currentEpoch = getCurrentEpoch(initTimestamp);
  log.info({ initTimestamp: Number(initTimestamp), currentEpoch }, 'Epoch info');

  // Only claim completed epochs (not the current in-progress one)
  const maxClaimableEpoch = currentEpoch - 1;
  if (maxClaimableEpoch < 0) {
    log.info('No completed epochs yet, nothing to claim');
    return;
  }

  const pods = await getUnclaimedPods();
  if (pods.length === 0) {
    log.info('No unclaimed pods found');
    return;
  }

  log.info({ podCount: pods.length, maxClaimableEpoch }, 'Processing unclaimed pods');

  // Group claims by buyer wallet so we can batch-transfer
  const buyerTotals = new Map<string, { amount: bigint; podIds: number[] }>();

  for (const pod of pods) {
    const { podId, buyerWallet } = pod;
    log.info({ podId, buyerWallet }, 'Checking pod emissions');

    // Figure out which epochs to claim for this pod.
    // We scan backwards from maxClaimableEpoch until we find already-claimed or zero-vote epochs.
    let totalClaimed = 0n;
    let claimedAnyEpoch = false;

    for (let epoch = maxClaimableEpoch; epoch >= 0; epoch--) {
      try {
        const alreadyClaimed = await hasClaimed(clients, podId, epoch);
        if (alreadyClaimed) {
          log.debug({ podId, epoch }, 'Already claimed, stopping scan');
          break;
        }

        let emissions: bigint;
        try {
          emissions = await getPodEmissions(clients, podId, epoch);
        } catch (err) {
          // ZeroVotes() revert means no emissions for this epoch
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('0xcdad98fd') || msg.includes('ZeroVotes')) {
            log.debug({ podId, epoch }, 'Zero votes, skipping');
            continue;
          }
          throw err;
        }

        if (emissions === 0n) {
          log.debug({ podId, epoch }, 'No emissions, skipping');
          continue;
        }

        log.info({ podId, epoch, emissions: formatUnits(emissions, 18) }, dryRun ? 'Would claim emissions (dry-run)' : 'Claiming emissions');
        if (!dryRun) {
          await claimPodOwnerEmissions(clients, podId, epoch);
        }
        totalClaimed += emissions;
        claimedAnyEpoch = true;
      } catch (err) {
        log.error({ podId, epoch, error: err instanceof Error ? err.message : err }, 'Failed to claim epoch');
      }
    }

    if (totalClaimed > 0n) {
      const existing = buyerTotals.get(buyerWallet) ?? { amount: 0n, podIds: [] };
      existing.amount += totalClaimed;
      existing.podIds.push(podId);
      buyerTotals.set(buyerWallet, existing);
    }
  }

  // Transfer accumulated REPPO to each buyer, then mark pods as claimed
  for (const [wallet, { amount, podIds }] of buyerTotals) {
    if (dryRun) {
      log.info({ wallet, amount: formatUnits(amount, 18), podIds }, 'Would transfer to buyer (dry-run)');
      continue;
    }
    try {
      log.info({ wallet, amount: formatUnits(amount, 18), podIds }, 'Transferring emissions to buyer');
      const transferTx = await transferReppo(clients, wallet as Address, amount);

      // Only mark claimed AFTER successful transfer
      for (const podId of podIds) {
        await markPodClaimed(podId, Number(formatUnits(amount / BigInt(podIds.length), 18)));
        log.info({ podId, wallet, transferTx }, 'Pod marked as claimed');
      }
    } catch (err) {
      log.error({ wallet, amount: formatUnits(amount, 18), podIds, error: err instanceof Error ? err.message : err }, 'Failed to transfer to buyer — pods NOT marked as claimed, will retry next run');
    }
  }

  log.info({ buyersProcessed: buyerTotals.size, podsProcessed: pods.length }, 'Emissions claim cron complete');
}

main().catch((err) => {
  log.fatal({ error: err instanceof Error ? err.message : err, stack: err instanceof Error ? err.stack : undefined }, 'Fatal error');
  process.exit(1);
});
