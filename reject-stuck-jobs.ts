/**
 * One-off script: scan all active ACP jobs and reject any whose tweet
 * has already been processed (dedup). This fixes jobs that were silently
 * removed from the pending queue without being rejected via ACP.
 *
 * Usage: npx tsx reject-stuck-jobs.ts [--dry-run]
 */
import 'dotenv/config';
import _AcpModule, { AcpContractClientV2, baseAcpConfigV2, baseSepoliaAcpConfigV2 } from '@virtuals-protocol/acp-node';
const AcpClient = (_AcpModule as any).default ?? _AcpModule;

import { loadConfig } from './src/config.js';
import { initDedup, hasProcessed, hasJobMinted } from './src/lib/dedup.js';
import { TWITTER_URL_REGEX } from './src/constants.js';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const config = loadConfig();
  initDedup(config.DATA_DIR);

  console.log(`Connecting to ACP (testnet=${config.ACP_TESTNET})...`);

  const pk = config.PRIVATE_KEY as `0x${string}`;
  const acpConfig = config.ACP_TESTNET ? baseSepoliaAcpConfigV2 : baseAcpConfigV2;

  const contractClient = await AcpContractClientV2.build(
    pk,
    config.ACP_SIGNER_ENTITY_ID,
    config.ACP_WALLET_ADDRESS as `0x${string}`,
    acpConfig,
  );

  const acpClient = new AcpClient({
    acpContractClient: contractClient,
    onNewTask: async () => {},
    onEvaluate: async () => {},
  });
  await acpClient.init();

  console.log('ACP client ready. Scanning active jobs...\n');

  const toReject: { jobId: number; reason: string }[] = [];

  // Paginate through all active jobs
  let page = 1;
  const pageSize = 50;
  let hasMore = true;

  while (hasMore) {
    const jobs = await acpClient.getActiveJobs(page, pageSize);
    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
      hasMore = false;
      break;
    }

    console.log(`Page ${page}: ${jobs.length} jobs`);

    for (const job of jobs) {
      const jobId = job.id ?? 'unknown';

      // Already minted — skip, this is fine
      if (hasJobMinted(jobId)) {
        console.log(`  [SKIP] Job ${jobId} — already minted`);
        continue;
      }

      // Extract postUrl from memos
      const memos = job.memos ?? [];
      let postUrl: string | null = null;
      for (const memo of memos) {
        try {
          const content = typeof memo.content === 'string' ? JSON.parse(memo.content) : memo.content;
          const req = content?.requirement ?? content;
          if (req?.postUrl) { postUrl = req.postUrl; break; }
          if (content?.postUrl) { postUrl = content.postUrl; break; }
        } catch { /* not JSON */ }
      }

      if (!postUrl) {
        console.log(`  [SKIP] Job ${jobId} — no postUrl in memos`);
        continue;
      }

      // Extract tweet ID
      const match = postUrl.match(TWITTER_URL_REGEX);
      if (!match?.[1]) {
        console.log(`  [SKIP] Job ${jobId} — invalid URL: ${postUrl}`);
        continue;
      }
      const tweetId = match[1];

      if (hasProcessed(tweetId)) {
        console.log(`  [REJECT] Job ${jobId} — tweet ${tweetId} already processed`);
        toReject.push({ jobId: Number(jobId), reason: `Tweet ${tweetId} already processed` });
      } else {
        console.log(`  [OK] Job ${jobId} — tweet ${tweetId} not yet processed`);
      }
    }

    if (jobs.length < pageSize) {
      hasMore = false;
    } else {
      page++;
    }
  }

  console.log(`\nFound ${toReject.length} jobs to reject.`);

  if (toReject.length === 0) {
    console.log('Nothing to do.');
    process.exit(0);
  }

  if (dryRun) {
    console.log('\n--dry-run: not rejecting. Remove flag to execute.');
    for (const { jobId, reason } of toReject) {
      console.log(`  Would reject job ${jobId}: ${reason}`);
    }
    process.exit(0);
  }

  console.log('\nRejecting jobs...');
  for (const { jobId, reason } of toReject) {
    try {
      const job = await acpClient.getJobById(jobId);
      if (!job) {
        console.log(`  [WARN] Job ${jobId} — could not fetch from ACP`);
        continue;
      }
      await job.reject(reason);
      console.log(`  [DONE] Job ${jobId} rejected`);
    } catch (err) {
      console.error(`  [ERROR] Job ${jobId} — ${(err as Error).message}`);
    }
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
