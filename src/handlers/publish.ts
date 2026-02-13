import { extractTweetId, fetchTweet } from '../twitter.js';
import { mintPod } from '../chain.js';
import { TWITTER_URL_REGEX } from '../constants.js';
import { submitPodMetadata, getOrCreateBuyerAgent } from '../reppo.js';
import { hasProcessed, markProcessed, acquireProcessingLock } from '../lib/dedup.js';
import { savePod } from '../lib/pods.js';
import { createLogger } from '../lib/logger.js';
import type { Clients, AgentSession, AcpDeliverable, AcpJob, ParsedJobContent } from '../types.js';
import type { Config } from '../config.js';
import type { AcpContext } from '../acp.js';

const log = createLogger('publish');

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
      if (req?.subnet && !result.subnet) result.subnet = req.subnet;
      if (req?.agentName && !result.agentName) result.agentName = req.agentName;
      if (req?.agentDescription && !result.agentDescription) result.agentDescription = req.agentDescription;
      if (req?.podName && !result.podName) result.podName = req.podName;
      if (req?.podDescription && !result.podDescription) result.podDescription = req.podDescription;
      // Also check top-level in case it's not nested
      if (content?.postUrl && !result.postUrl) result.postUrl = content.postUrl;
      if (content?.subnet && !result.subnet) result.subnet = content.subnet;
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
  log.info({ jobId }, 'Processing job');

  // Parse job content
  const content = parseJobContent(job);
  
  // === Validation BEFORE accepting ===

  // Validate fare amount (minimum 1 USDC to cover minting costs)
  const MIN_FARE_USDC = 5; // 5 USDC minimum
  if (!job.price || job.price < MIN_FARE_USDC) {
    log.warn({ jobId, price: job.price }, 'Fare too low');
    await job.reject(`Fare too low. Minimum: ${MIN_FARE_USDC} USDC. Got: ${job.price ?? 0}`);
    return;
  }
  log.info({ jobId, price: job.price }, 'Fare validated');
  
  // Validate required fields
  if (!content.postUrl) {
    log.warn({ jobId }, 'Missing postUrl');
    await job.reject('Missing postUrl in job payload');
    return;
  }

  if (!content.subnet) {
    log.warn({ jobId }, 'Missing subnet');
    await job.reject('Missing subnet in job payload');
    return;
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
      if (phase === 0) {
        await job.accept('Processing X post for pod minting');
        log.info({ jobId, tweetId, phase }, 'Job accepted');
      }
      // Post requirement so buyer can payAndAcceptRequirement
      await (job as any).createRequirement('Pod minting for X post. Pay to proceed.');
      log.info({ jobId, tweetId, phase }, 'Requirement posted, waiting for buyer payment');
    } catch (err) {
      log.warn({ jobId, tweetId, error: (err as Error).message }, 'Accept/requirement failed');
    }
    releaseLock();
    return;
  }

  // Phase 2+ (TRANSACTION): Buyer has paid, do the work
  log.info({ jobId, tweetId, phase }, 'Buyer paid, processing...');

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

    // Track pod for emissions distribution (wallet that requested the pod)
    const buyerWallet = buyerId ?? clients.account.address;
    if (mintResult.podId) {
      await savePod(
        Number(mintResult.podId),
        buyerWallet,
        mintResult.txHash,
      );
      log.info({ podId: mintResult.podId, buyerWallet }, 'Pod tracked for emissions');
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

    // Submit metadata to Reppo (use custom name/description if provided, otherwise from tweet)
    const title = content.podName || (tweet.text.length > 100 ? tweet.text.slice(0, 97) + '...' : tweet.text);
    const description = content.podDescription || tweet.text;
    
    // Submit metadata to Reppo (skip for now - causing crashes)
    // try {
    //   await submitPodMetadata(publishSession, config, {
    //     txHash: mintResult.txHash,
    //     title,
    //     description,
    //     url: content.postUrl,
    //     imageUrl: tweet.mediaUrls[0],
    //     tokenId: mintResult.podId !== undefined ? Number(mintResult.podId) : undefined,
    //     category: 'social',
    //     subnet: content.subnet,
    //   });
    // } catch (metaErr) {
    //   log.warn({ jobId, error: metaErr instanceof Error ? metaErr.message : metaErr }, 'Metadata submission failed - pod still minted');
    // }
    log.info({ jobId, podId: mintResult.podId }, 'Pod minted, skipping metadata submission');

    // Deliver result (fire and forget - don't crash if it fails)
    const basescanUrl = `https://basescan.org/tx/${mintResult.txHash}`;
    const deliverable: AcpDeliverable = {
      postUrl: content.postUrl,
      subnet: content.subnet,
      txHash: mintResult.txHash,
      podId: mintResult.podId?.toString(),
      basescanUrl,
    };
    
    // Don't await - just deliver and mark processed
    job.deliver(deliverable).catch(err => 
      log.error({ jobId, error: err instanceof Error ? err.message : err }, 'Deliver failed')
    );
    markProcessed(tweetId).catch(err =>
      log.error({ jobId, error: err instanceof Error ? err.message : err }, 'Mark processed failed')
    );
    
    log.info({ jobId, basescanUrl }, 'Job delivered successfully');
    return;

  } catch (err) {
    // Don't mark as processed on failure - allow retry
    log.error({ jobId, tweetId, error: (err as Error).message }, 'Job processing failed');
    // Don't throw - let job stay in active state for retry
  } finally {
    releaseLock();
  }
}
