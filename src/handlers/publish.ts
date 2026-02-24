import { extractTweetId, fetchTweet } from '../twitter.js';
import { mintPod } from '../chain.js';
import { TWITTER_URL_REGEX, MAX_SUBNETS_PER_JOB } from '../constants.js';
import { submitPodMetadata, getOrCreateBuyerAgent, getSubnets } from '../reppo.js';
import { hasProcessed, markProcessed, acquireProcessingLock, hasJobMinted, markJobMinted } from '../lib/dedup.js';
import { savePod, getJobMint } from '../lib/pods.js';
import {
  savePendingJob,
  updatePendingJobStatus,
  removePendingJob,
  getPendingJobs,
  getPendingJob,
  recordPendingJobError,
} from '../lib/pending-jobs.js';
import { createLogger } from '../lib/logger.js';
import type { Clients, AgentSession, AcpDeliverable, AcpJob, ParsedJobContent, PendingJob } from '../types.js';
import type { Config } from '../config.js';
import type { AcpContext } from '../acp.js';

/**
 * Reject a job by ID using the ACP client (for cases where we don't have the job object)
 */
async function rejectJobById(acpClient: AcpContext['client'], jobId: string, reason: string): Promise<boolean> {
  try {
    const job = await acpClient.getJobById(Number(jobId));
    if (job) {
      await job.reject(reason);
      log.info({ jobId, reason }, 'Job rejected via ACP');
      return true;
    }
    log.warn({ jobId }, 'Could not fetch job from ACP to reject');
    return false;
  } catch (err) {
    log.error({ jobId, error: (err as Error).message }, 'Failed to reject job via ACP');
    return false;
  }
}

const log = createLogger('publish');

/**
 * Normalize subnet input to a string array.
 * Accepts: subnets: string[], subnet: "a, b" (comma-separated), subnet: "single"
 */
function normalizeSubnets(source: Record<string, unknown>): string[] | undefined {
  // Prefer subnets array
  if (Array.isArray(source?.subnets)) {
    return source.subnets.map((s: unknown) => String(s).trim()).filter(Boolean);
  }
  // Fall back to subnet string (comma-separated or single)
  if (typeof source?.subnet === 'string' && source.subnet.trim()) {
    return source.subnet.split(',').map((s: string) => s.trim()).filter(Boolean);
  }
  return undefined;
}

/**
 * Parse job content from ACP memos
 */
function parseJobContent(job: AcpJob): ParsedJobContent {
  const memos = job.memos ?? [];
  const result: ParsedJobContent = {};

  for (const memo of memos) {
    try {
      const content = typeof memo.content === 'string'
        ? JSON.parse(memo.content)
        : memo.content;

      // Check top-level and nested under "requirement" (ACP SDK wraps serviceRequirements there)
      const req = content?.requirement ?? content;
      if (req?.postUrl && !result.postUrl) result.postUrl = req.postUrl;
      if (!result.subnets) result.subnets = normalizeSubnets(req);
      if (req?.agentName && !result.agentName) result.agentName = req.agentName;
      if (req?.agentDescription && !result.agentDescription) result.agentDescription = req.agentDescription;
      if (req?.podName && !result.podName) result.podName = req.podName;
      if (req?.podDescription && !result.podDescription) result.podDescription = req.podDescription;
      // Also check top-level in case it's not nested
      if (content?.postUrl && !result.postUrl) result.postUrl = content.postUrl;
      if (!result.subnets) result.subnets = normalizeSubnets(content);
    } catch {
      // Not JSON, skip
    }
  }

  return result;
}

/**
 * Extract buyer identifier from ACP job
 */
function getBuyerId(job: AcpJob): string | null {
  // Try various field names from ACP SDK
  const buyerId = job.clientAddress 
    ?? job.buyerAddress 
    ?? job.client?.address 
    ?? job.buyer?.address
    ?? null;
  
  if (!buyerId) {
    log.warn({ jobId: job.id }, 'Could not extract buyer ID from job');
  }
  
  return buyerId;
}

// AcpJobPhases: REQUEST=0, NEGOTIATION=1, TRANSACTION=2, EVALUATION=3, COMPLETED=4
const PHASE_TRANSACTION = 2;

export async function handlePublishJob(
  job: AcpJob,
  clients: Clients,
  session: AgentSession,
  config: Config,
): Promise<void> {
  const jobId = job.id ?? 'unknown';
  
  // Skip already-processed jobs (minted or manually skipped)
  if (hasJobMinted(jobId)) {
    return; // Silent skip — already handled
  }

  log.info({ jobId }, 'Processing job');

  // Parse job content
  const content = parseJobContent(job);
  
  // === Validation BEFORE accepting ===
  
  // Validate required fields
  if (!content.postUrl) {
    log.warn({ jobId }, 'Missing postUrl');
    await job.reject('Missing postUrl in job payload');
    return;
  }

  if (!content.subnets || content.subnets.length === 0) {
    log.warn({ jobId }, 'Missing subnet');
    await job.reject('Missing subnet in job payload');
    return;
  }

  if (content.subnets.length > MAX_SUBNETS_PER_JOB) {
    log.warn({ jobId, count: content.subnets.length }, 'Too many subnets');
    await job.reject(`Too many subnets (${content.subnets.length}). Maximum is ${MAX_SUBNETS_PER_JOB}.`);
    return;
  }

  // Validate all subnets and resolve names to IDs
  try {
    const subnets = await getSubnets(config);
    const raw = (subnets as any)?.data;
    const subnetList: any[] = raw?.privateSubnets ?? raw?.subnets ?? (Array.isArray(raw) ? raw : []);
    const validIds = subnetList.map((s: any) => String(s.id));
    const normalize = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '_');

    if (subnetList.length > 0) {
      const resolvedIds: string[] = [];
      for (const sn of content.subnets) {
        if (validIds.includes(sn)) {
          resolvedIds.push(sn);
        } else {
          const needle = normalize(sn);
          const match = subnetList.find((s: any) => normalize(String(s.subnet ?? s.name ?? '')) === needle);
          if (match) {
            log.info({ jobId, from: sn, to: match.id }, 'Resolved subnet name to ID');
            resolvedIds.push(String(match.id));
          } else {
            log.warn({ jobId, subnet: sn, validIds }, 'Invalid subnet');
            await job.reject(`Invalid subnet "${sn}". Available: ${subnetList.map((s: any) => `${s.subnet || s.name} (id: ${s.id})`).join(', ')}`);
            return;
          }
        }
      }
      // Deduplicate resolved IDs
      content.subnets = [...new Set(resolvedIds)];
    }
  } catch (err) {
    log.warn({ jobId, error: (err as Error).message }, 'Failed to validate subnets, proceeding anyway');
  }

  // Validate URL format
  if (!TWITTER_URL_REGEX.test(content.postUrl)) {
    log.warn({ jobId, url: content.postUrl }, 'Invalid URL format');
    await job.reject(`Invalid X/Twitter URL: ${content.postUrl}`);
    return;
  }

  // Extract tweet ID
  const tweetId = extractTweetId(content.postUrl);
  
  // Check dedup BEFORE accepting
  if (hasProcessed(tweetId)) {
    log.warn({ jobId, tweetId }, 'Tweet already processed (dedup)');
    await job.reject(`Tweet ${tweetId} already processed`);
    return;
  }

  // Acquire processing lock to prevent concurrent processing of same tweet
  const releaseLock = await acquireProcessingLock(tweetId);
  if (!releaseLock) {
    log.warn({ jobId, tweetId }, 'Tweet currently being processed, skipping duplicate event');
    return; // Don't reject — likely a duplicate socket event for the same job
  }

  // Double-check dedup after acquiring lock (another job might have just finished)
  if (hasProcessed(tweetId)) {
    releaseLock();
    log.warn({ jobId, tweetId }, 'Tweet was processed while waiting for lock');
    await job.reject(`Tweet ${tweetId} already processed`);
    return;
  }

  // === Phase-aware flow: accept first, process after buyer pays ===
  const phase = typeof job.phase === 'number' ? job.phase : -1;

  // Phase 0-1: Accept the job and post requirement, then wait for buyer payment
  if (phase <= 1) {
    try {
      // Fetch available subnets to include in messages
      let subnetInfo = '';
      try {
        const subnets = await getSubnets(config);
        const rawData = (subnets as any)?.data;
        const subnetList = rawData?.privateSubnets ?? rawData?.subnets ?? (Array.isArray(rawData) ? rawData : []);
        if (Array.isArray(subnetList) && subnetList.length > 0) {
          subnetInfo = ` Available subnets: ${subnetList.map((s: any) => `${s.subnet || s.name} (id: ${s.id})`).join(', ')}.`;
        }
      } catch {
        // Non-fatal — proceed without subnet info
      }

      if (phase === 0) {
        await job.accept(`Processing X post for pod minting. Please include a "subnet" field (name or ID, comma-separated for multiple) or "subnets" array in your job payload. You can ask the Reppo agent for a list of available subnets.${subnetInfo}`);
        log.info({ jobId, tweetId, phase }, 'Job accepted');
      }

      // Checkpoint A: persist job after accepting
      await savePendingJob({
        jobId: String(jobId),
        tweetId,
        postUrl: content.postUrl,
        subnets: content.subnets!,
        buyerId: getBuyerId(job),
        agentName: content.agentName,
        agentDescription: content.agentDescription,
        podName: content.podName,
        podDescription: content.podDescription,
        status: 'accepted',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        retryCount: 0,
      });

      // Post requirement so buyer can payAndAcceptRequirement
      await (job as any).createRequirement(`Pod minting for X post. Pay to proceed. Required fields: "postUrl" (X/Twitter URL) and "subnet" (name or ID, comma-separated for multiple) or "subnets" array. You can ask the Reppo agent for the list of available subnets.${subnetInfo}`);
      log.info({ jobId, tweetId, phase }, 'Requirement posted, waiting for buyer payment');
    } catch (err) {
      log.warn({ jobId, tweetId, error: (err as Error).message }, 'Accept/requirement failed');
    }
    releaseLock();
    return;
  }

  // Phase 2+ (TRANSACTION): Buyer has paid, do the work
  log.info({ jobId, tweetId, phase }, 'Buyer paid, processing...');

  // Checkpoint B: ensure job is tracked even if we missed phase 0-1
  if (!getPendingJob(String(jobId))) {
    await savePendingJob({
      jobId: String(jobId),
      tweetId,
      postUrl: content.postUrl,
      subnets: content.subnets!,
      buyerId: getBuyerId(job),
      agentName: content.agentName,
      agentDescription: content.agentDescription,
      podName: content.podName,
      podDescription: content.podDescription,
      status: 'accepted',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      retryCount: 0,
    });
  }

  try {

    // Fetch tweet data
    log.info({ jobId, tweetId }, 'Fetching tweet...');
    const tweet = await fetchTweet(tweetId);
    log.info({ 
      jobId, 
      author: tweet.authorUsername, 
      textPreview: tweet.text.slice(0, 80),
    }, 'Tweet fetched');

    // Get buyer info BEFORE minting (needed for tracking)
    const buyerId = getBuyerId(job);

    // Check if this job was already minted (DynamoDB + in-memory)
    if (hasJobMinted(jobId)) {
      log.warn({ jobId }, 'Job already minted (memory), skipping');
      releaseLock();
      return;
    }
    const existingMint = await getJobMint(Number(jobId));
    if (existingMint) {
      log.warn({ jobId, podId: existingMint.podId, txHash: existingMint.mintTxHash }, 'Job already minted (DynamoDB), skipping');
      await markJobMinted(jobId);
      releaseLock();
      return;
    }

    // Mint pod on-chain
    log.info({ jobId }, 'Minting pod...');
    let mintResult;
    try {
      mintResult = await mintPod(clients);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('Insufficient REPPO')) {
        await job.reject(`Agent insufficient REPPO to mint pod: ${msg}`);
        releaseLock();
        return;
      }
      throw err;
    }
    log.info({ 
      jobId, 
      txHash: mintResult.txHash, 
      podId: mintResult.podId?.toString(),
    }, 'Pod minted');

    // Mark job as minted IMMEDIATELY to prevent duplicate mints
    await markJobMinted(jobId);
    await markProcessed(tweetId);

    // Checkpoint C: record mint success so retry can resume from here
    await updatePendingJobStatus(String(jobId), 'minted', {
      mintTxHash: mintResult.txHash,
      podId: mintResult.podId !== undefined ? Number(mintResult.podId) : undefined,
    });

    // Track pod for emissions distribution (wallet that requested the pod)
    const buyerWallet = buyerId ?? clients.account.address;
    if (mintResult.podId) {
      await savePod(
        Number(mintResult.podId),
        buyerWallet,
        mintResult.txHash,
        undefined,
        Number(jobId),
      );
      log.info({ podId: mintResult.podId, buyerWallet, jobId }, 'Pod tracked for emissions');
    }

    // Get or create buyer's Reppo profile if agent info provided
    let publishSession = session; // default to reppodant
    
    if (buyerId && content.agentName) {
      const buyerSession = await getOrCreateBuyerAgent(
        config, 
        buyerId, 
        content.agentName, 
        content.agentDescription,
      );
      if (buyerSession) {
        publishSession = buyerSession;
        log.info({ jobId, buyerAgentId: buyerSession.agentId }, 'Using buyer profile');
      }
    }

    // Submit metadata to each subnet (non-fatal per-subnet)
    const title = content.podName || (tweet.text.length > 100 ? tweet.text.slice(0, 97) + '...' : tweet.text);
    const description = content.podDescription || tweet.text;

    const completedSubnets: string[] = [];
    const failedSubnets: string[] = [];

    for (const subnetId of content.subnets!) {
      try {
        await submitPodMetadata(publishSession, config, {
          txHash: mintResult.txHash,
          title,
          description,
          url: content.postUrl,
          imageUrl: tweet.mediaUrls[0],
          tokenId: mintResult.podId !== undefined ? Number(mintResult.podId) : undefined,
          category: 'social',
          subnetId,
        });
        completedSubnets.push(subnetId);
        log.info({ jobId, subnetId }, 'Metadata submitted to subnet');
      } catch (metaErr) {
        failedSubnets.push(subnetId);
        log.warn({ jobId, subnetId, error: metaErr instanceof Error ? metaErr.message : metaErr }, 'Metadata submission failed for subnet');
      }
    }

    if (completedSubnets.length > 0) {
      log.info({ jobId, completedSubnets }, 'Metadata submitted to subnets');
    }
    if (failedSubnets.length > 0) {
      log.warn({ jobId, failedSubnets }, 'Metadata submission failed for some subnets - pod still minted');
    }

    // Deliver result via ACP (deliver even on partial failure — pod IS minted)
    const basescanUrl = `https://basescan.org/tx/${mintResult.txHash}`;
    const deliverable: AcpDeliverable = {
      postUrl: content.postUrl,
      subnets: completedSubnets,
      txHash: mintResult.txHash,
      podId: mintResult.podId?.toString(),
      basescanUrl,
      ...(failedSubnets.length > 0 ? { failedSubnets } : {}),
    };
    await job.deliver(deliverable);
    log.info({ jobId, basescanUrl, completedSubnets, failedSubnets }, 'Job delivered successfully');

    // Checkpoint D: job fully completed, remove from WAL
    await removePendingJob(String(jobId));

  } catch (err) {
    const errorMsg = (err as Error).message ?? String(err);
    log.error({ jobId, tweetId, error: errorMsg }, 'Job processing failed');

    // Checkpoint E: record error for retry
    await recordPendingJobError(String(jobId), errorMsg);

    // Reject job if we can't fulfill it (insufficient funds, etc.)
    if (errorMsg.includes('Insufficient REPPO')) {
      try {
        await job.reject?.('Insufficient REPPO to mint pod. Please try again later.');
        log.info({ jobId }, 'Job rejected — insufficient REPPO');
      } catch (rejectErr) {
        log.error({ jobId, error: (rejectErr as Error).message }, 'Failed to reject job');
      }
    }
  } finally {
    releaseLock();
  }
}

const ACCEPTED_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Retry incomplete pending jobs on startup.
 * - 'accepted': re-mint from scratch (buyer likely paid but we crashed before minting)
 * - 'minted': pod exists on-chain, just need DynamoDB + metadata
 */
export async function retryPendingJobs(
  clients: Clients,
  session: AgentSession,
  config: Config,
  acpContext?: AcpContext,
): Promise<void> {
  const pending = getPendingJobs();
  if (pending.length === 0) {
    log.info('No pending jobs to retry');
    return;
  }

  log.info({ count: pending.length }, 'Retrying pending jobs...');

  for (const pj of pending) {
    try {
      if (pj.status === 'accepted') {
        // Skip if older than 24h — buyer likely never paid, but reject to be safe
        const age = Date.now() - new Date(pj.createdAt).getTime();
        if (age > ACCEPTED_MAX_AGE_MS) {
          log.info({ jobId: pj.jobId }, 'Accepted job older than 24h, rejecting');
          if (acpContext) {
            await rejectJobById(acpContext.client, pj.jobId, 'Job expired (accepted over 24h ago)');
          }
          await removePendingJob(pj.jobId);
          continue;
        }

        // Check dedup — already processed?
        const tweetId = extractTweetId(pj.postUrl);
        if (hasProcessed(tweetId)) {
          log.warn({ jobId: pj.jobId, tweetId }, 'Tweet already processed, rejecting job');
          if (acpContext) {
            await rejectJobById(acpContext.client, pj.jobId, `Tweet ${tweetId} already processed`);
          } else {
            log.warn({ jobId: pj.jobId }, 'No ACP context available to reject job — buyer will not be refunded');
          }
          await removePendingJob(pj.jobId);
          continue;
        }

        // Fetch tweet
        const tweet = await fetchTweet(tweetId);

        // Mint pod
        const mintResult = await mintPod(clients);
        await markJobMinted(pj.jobId);
        await markProcessed(tweetId);

        await updatePendingJobStatus(pj.jobId, 'minted', {
          mintTxHash: mintResult.txHash,
          podId: mintResult.podId !== undefined ? Number(mintResult.podId) : undefined,
        });

        // Save pod to DynamoDB
        const buyerWallet = pj.buyerId ?? clients.account.address;
        if (mintResult.podId) {
          await savePod(
            Number(mintResult.podId),
            buyerWallet,
            mintResult.txHash,
            undefined,
            Number(pj.jobId),
          );
        }

        // Submit metadata to each subnet
        let publishSession = session;
        if (pj.buyerId && pj.agentName) {
          const buyerSession = await getOrCreateBuyerAgent(config, pj.buyerId, pj.agentName, pj.agentDescription);
          if (buyerSession) publishSession = buyerSession;
        }

        const title = pj.podName || (tweet.text.length > 100 ? tweet.text.slice(0, 97) + '...' : tweet.text);
        const description = pj.podDescription || tweet.text;

        const completed = pj.completedSubnets ?? [];
        const remaining = pj.subnets.filter((s) => !completed.includes(s));
        for (const subnetId of remaining) {
          try {
            await submitPodMetadata(publishSession, config, {
              txHash: mintResult.txHash,
              title,
              description,
              url: pj.postUrl,
              imageUrl: tweet.mediaUrls[0],
              tokenId: mintResult.podId !== undefined ? Number(mintResult.podId) : undefined,
              category: 'social',
              subnetId,
            });
            completed.push(subnetId);
          } catch (metaErr) {
            log.warn({ jobId: pj.jobId, subnetId, error: (metaErr as Error).message }, 'Metadata submission failed for subnet during retry');
          }
        }

        await removePendingJob(pj.jobId);
        log.info({ jobId: pj.jobId, completedSubnets: completed }, 'Pending job retried successfully (accepted → completed)');

      } else if (pj.status === 'minted') {
        // Pod minted on-chain but DynamoDB/metadata failed
        const buyerWallet = pj.buyerId ?? clients.account.address;
        if (pj.podId && pj.mintTxHash) {
          await savePod(
            pj.podId,
            buyerWallet,
            pj.mintTxHash as `0x${string}`,
            undefined,
            Number(pj.jobId),
          );
        }

        // Fetch tweet for metadata content
        const tweetId = extractTweetId(pj.postUrl);
        const tweet = await fetchTweet(tweetId);

        let publishSession = session;
        if (pj.buyerId && pj.agentName) {
          const buyerSession = await getOrCreateBuyerAgent(config, pj.buyerId, pj.agentName, pj.agentDescription);
          if (buyerSession) publishSession = buyerSession;
        }

        const title = pj.podName || (tweet.text.length > 100 ? tweet.text.slice(0, 97) + '...' : tweet.text);
        const description = pj.podDescription || tweet.text;

        if (pj.mintTxHash) {
          const completed = pj.completedSubnets ?? [];
          const remaining = pj.subnets.filter((s) => !completed.includes(s));
          for (const subnetId of remaining) {
            try {
              await submitPodMetadata(publishSession, config, {
                txHash: pj.mintTxHash as `0x${string}`,
                title,
                description,
                url: pj.postUrl,
                imageUrl: tweet.mediaUrls[0],
                tokenId: pj.podId,
                category: 'social',
                subnetId,
              });
              completed.push(subnetId);
            } catch (metaErr) {
              log.warn({ jobId: pj.jobId, subnetId, error: (metaErr as Error).message }, 'Metadata submission failed for subnet during retry');
            }
          }
        }

        await removePendingJob(pj.jobId);
        log.info({ jobId: pj.jobId }, 'Pending job retried successfully (minted → completed)');
      }
    } catch (err) {
      const errorMsg = (err as Error).message ?? String(err);
      log.error({ jobId: pj.jobId, error: errorMsg }, 'Pending job retry failed');
      await recordPendingJobError(pj.jobId, errorMsg);
    }
  }
}
