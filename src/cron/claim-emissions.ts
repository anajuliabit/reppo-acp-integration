import 'dotenv/config';
import { formatUnits, encodeFunctionData, createPublicClient, http, type Address, type Hash } from 'viem';
import { base } from 'viem/chains';
import { AcpContractClientV2, baseAcpConfigV2, baseSepoliaAcpConfigV2 } from '@virtuals-protocol/acp-node';
import { initPods, getAllPods, updatePodEmissions } from '../lib/pods.js';
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

const log = createLogger('claim-emissions');
const dryRun = process.argv.includes('--dry-run');

// Lightweight client type for this cron (uses AA wallet, not EOA walletClient)
interface CronClients {
  publicClient: any; // viem PublicClient — typed as any to avoid cross-version type mismatch
  aaClient: any; // sessionKeyClient from AcpContractClientV2
  aaWalletAddress: Address;
}

class ZeroVotesError extends Error {
  constructor(podId: number, epoch: number) {
    super(`ZeroVotes for pod ${podId} epoch ${epoch}`);
    this.name = 'ZeroVotesError';
  }
}

function isZeroVotesError(err: unknown): boolean {
  if (err instanceof ZeroVotesError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('0xcdad98fd') || msg.includes('ZeroVotes');
}

async function getInitTimestamp(clients: CronClients): Promise<bigint> {
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

function getEpochForTimestamp(initTimestamp: bigint, isoDate: string): number {
  const ts = BigInt(Math.floor(new Date(isoDate).getTime() / 1000));
  const elapsed = ts - initTimestamp;
  if (elapsed <= 0n) return 0;
  return Number(elapsed / BigInt(EPOCH_DURATION));
}

function getCurrentEpoch(initTimestamp: bigint): number {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const elapsed = now - initTimestamp;
  if (elapsed <= 0n) return 0;
  return Number(elapsed / BigInt(EPOCH_DURATION));
}

async function getPodEmissions(clients: CronClients, podId: number, epoch: number): Promise<bigint> {
  // Don't retry ZeroVotes — it's a definitive "no votes" response, not transient
  return withRetry(
    async () => {
      try {
        return (await clients.publicClient.readContract({
          address: POD_CONTRACT,
          abi: POD_ABI,
          functionName: 'getPodEmissionsOfEpoch',
          args: [BigInt(epoch), BigInt(podId)],
        })) as bigint;
      } catch (err) {
        if (isZeroVotesError(err)) {
          throw new ZeroVotesError(podId, epoch); // will NOT be retried
        }
        throw err;
      }
    },
    `getPodEmissions(${podId},${epoch})`,
    { shouldRetry: (err) => !isZeroVotesError(err) && isRetryableError(err) },
  );
}

async function hasClaimed(clients: CronClients, podId: number, epoch: number): Promise<boolean> {
  return withRetry(
    async () =>
      (await clients.publicClient.readContract({
        address: POD_CONTRACT,
        abi: POD_ABI,
        functionName: 'hasPodOwnerClaimedEmissions',
        args: [BigInt(epoch), BigInt(podId)],
      })) as boolean,
    `hasClaimed(${podId},${epoch})`,
    { shouldRetry: isRetryableError },
  );
}

async function getReppoBalance(clients: CronClients): Promise<bigint> {
  return withRetry(
    async () =>
      (await clients.publicClient.readContract({
        address: REPPO_TOKEN,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [clients.aaWalletAddress],
      })) as bigint,
    'getReppoBalance',
    { shouldRetry: isRetryableError },
  );
}

async function claimPodOwnerEmissions(clients: CronClients, podId: number, epoch: number): Promise<string> {
  const { publicClient, aaClient } = clients;

  const data = encodeFunctionData({
    abi: POD_ABI,
    functionName: 'claimPodOwnerEmissions',
    args: [BigInt(podId), BigInt(epoch)],
  });

  const tx = await withRetry(
    () => aaClient.sendTransaction({ to: POD_CONTRACT, data }),
    `claimEmissions(${podId},${epoch})`,
    { shouldRetry: isRetryableError },
  ) as Hash;

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: tx,
    timeout: TX_RECEIPT_TIMEOUT,
  });

  if (receipt.status === 'reverted') {
    throw new Error(`Claim tx reverted: ${tx}`);
  }

  log.info({ podId, epoch, tx }, 'Emissions claimed on-chain via AA');
  return tx;
}

async function transferReppo(clients: CronClients, to: Address, amount: bigint): Promise<string> {
  const { publicClient, aaClient } = clients;

  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [to, amount],
  });

  const tx = await withRetry(
    () => aaClient.sendTransaction({ to: REPPO_TOKEN, data }),
    `transferReppo(${to})`,
    { shouldRetry: isRetryableError },
  ) as Hash;

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: tx,
    timeout: TX_RECEIPT_TIMEOUT,
  });

  if (receipt.status === 'reverted') {
    throw new Error(`Transfer tx reverted: ${tx}`);
  }

  log.info({ to, amount: formatUnits(amount, 18), tx }, 'REPPO transferred to buyer via AA');
  return tx;
}

async function main() {
  log.info({ dryRun }, 'Starting emissions claim cron...');

  // Required env vars for AA wallet
  const privateKey = process.env.PRIVATE_KEY;
  const acpSignerEntityId = process.env.ACP_SIGNER_ENTITY_ID || process.env.ACP_ENTITY_ID;
  const acpWalletAddress = process.env.ACP_WALLET_ADDRESS;
  const rpcUrl = process.env.RPC_URL;
  const useTestnet = process.env.ACP_TESTNET === 'true';

  if (!privateKey || !acpSignerEntityId || !acpWalletAddress) {
    log.fatal('PRIVATE_KEY, ACP_SIGNER_ENTITY_ID (or ACP_ENTITY_ID), and ACP_WALLET_ADDRESS are required');
    process.exit(1);
  }

  // Init DynamoDB
  initPods({
    DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT,
    AWS_REGION: process.env.AWS_REGION,
  });

  // Build AA client (same pattern as src/acp.ts)
  const pk = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const acpConfig = useTestnet ? baseSepoliaAcpConfigV2 : baseAcpConfigV2;

  log.info({ acpWalletAddress, signerEntityId: acpSignerEntityId }, 'Building ACP contract client for AA...');
  const contractClient = await AcpContractClientV2.build(
    pk,
    parseInt(acpSignerEntityId, 10),
    acpWalletAddress as `0x${string}`,
    acpConfig,
  );
  const aaClient = (contractClient as any).sessionKeyClient;

  const transport = rpcUrl ? http(rpcUrl) : http();
  const publicClient = createPublicClient({ chain: base, transport });

  const clients: CronClients = {
    publicClient,
    aaClient,
    aaWalletAddress: acpWalletAddress as Address,
  };

  log.info({ aaWallet: acpWalletAddress }, 'AA client ready (gas sponsored by Virtuals)');

  const initTimestamp = await getInitTimestamp(clients);
  const currentEpoch = getCurrentEpoch(initTimestamp);
  log.info({ initTimestamp: Number(initTimestamp), currentEpoch }, 'Epoch info');

  // Contract requires epoch + 2 <= latestEpoch, so max claimable = currentEpoch - 2
  const maxClaimableEpoch = currentEpoch - 2;
  if (maxClaimableEpoch < 0) {
    log.info('No claimable epochs yet');
    return;
  }

  const pods = await getAllPods();
  if (pods.length === 0) {
    log.info('No pods found');
    return;
  }

  log.info({ podCount: pods.length, maxClaimableEpoch }, 'Processing pods');

  // Process each pod: claim on-chain, then transfer to buyer and update DynamoDB
  for (const pod of pods) {
    const { podId, buyerWallet, createdAt, lastClaimedEpoch } = pod;

    const mintEpoch = getEpochForTimestamp(initTimestamp, createdAt);

    if (mintEpoch > maxClaimableEpoch) {
      log.info({ podId, buyerWallet, mintEpoch, maxClaimableEpoch }, 'Pod too new, skipping');
      continue;
    }

    // Start scanning from where we left off (or mint epoch if first run)
    const startEpoch = lastClaimedEpoch != null ? lastClaimedEpoch + 1 : mintEpoch;

    if (startEpoch > maxClaimableEpoch) {
      log.debug({ podId, startEpoch, maxClaimableEpoch }, 'Already up to date');
      continue;
    }

    log.info({ podId, buyerWallet, scanRange: `${startEpoch}→${maxClaimableEpoch}` }, 'Checking pod emissions');

    // Snapshot REPPO balance before claims for this pod
    const balanceBefore = dryRun ? 0n : await getReppoBalance(clients);
    let highestClaimedEpoch = lastClaimedEpoch ?? -1;
    let claimedCount = 0;

    for (let epoch = startEpoch; epoch <= maxClaimableEpoch; epoch++) {
      try {
        const alreadyClaimed = await hasClaimed(clients, podId, epoch);
        if (alreadyClaimed) {
          // Already claimed on-chain (maybe manually), just update our tracking
          highestClaimedEpoch = Math.max(highestClaimedEpoch, epoch);
          continue;
        }

        let emissions: bigint;
        try {
          emissions = await getPodEmissions(clients, podId, epoch);
        } catch (err) {
          if (isZeroVotesError(err)) {
            log.debug({ podId, epoch }, 'Zero votes, skipping');
            continue;
          }
          throw err;
        }

        if (emissions === 0n) {
          log.debug({ podId, epoch }, 'No emissions, skipping');
          continue;
        }

        log.info({ podId, epoch, emissions: formatUnits(emissions, 18) }, dryRun ? 'Would claim (dry-run)' : 'Claiming');
        if (!dryRun) {
          await claimPodOwnerEmissions(clients, podId, epoch);
          claimedCount++;
        }
        highestClaimedEpoch = Math.max(highestClaimedEpoch, epoch);
      } catch (err) {
        log.error({ podId, epoch, error: err instanceof Error ? err.message : err }, 'Failed to claim epoch');
      }
    }

    // Calculate actual REPPO received by comparing balance
    const balanceAfter = dryRun ? 0n : await getReppoBalance(clients);
    const actualReceived = balanceAfter - balanceBefore;

    if (dryRun) {
      if (highestClaimedEpoch > (lastClaimedEpoch ?? -1)) {
        log.info({ podId, buyerWallet, highestClaimedEpoch }, 'Would update (dry-run)');
      }
      continue;
    }

    if (actualReceived > 0n) {
      // Transfer actual received amount to buyer
      try {
        log.info({ podId, buyerWallet, amount: formatUnits(actualReceived, 18), claimedCount }, 'Transferring emissions to buyer');
        await transferReppo(clients, buyerWallet as Address, actualReceived);

        // Update DynamoDB with actual amount and last epoch
        await updatePodEmissions(podId, highestClaimedEpoch, Number(formatUnits(actualReceived, 18)));
      } catch (err) {
        log.error({ podId, buyerWallet, amount: formatUnits(actualReceived, 18), error: err instanceof Error ? err.message : err },
          'Failed to transfer — will retry next run (on-chain claims succeeded but REPPO still in AA wallet)');
      }
    } else if (highestClaimedEpoch > (lastClaimedEpoch ?? -1)) {
      // No REPPO received but we scanned new epochs — update tracking
      await updatePodEmissions(podId, highestClaimedEpoch, 0);
    }
  }

  log.info({ podsProcessed: pods.length }, 'Emissions claim cron complete');
}

main().catch((err) => {
  log.fatal({ error: err instanceof Error ? err.message : err, stack: err instanceof Error ? err.stack : undefined }, 'Fatal error');
  process.exit(1);
});
