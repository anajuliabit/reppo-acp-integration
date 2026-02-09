import { extractTweetId, fetchTweet } from '../twitter.js';
import { mintPod } from '../chain.js';
import { submitPodMetadata, getOrCreateBuyerAgent } from '../reppo.js';
import type { Clients, AgentSession, AcpDeliverable } from '../types.js';
import type { Config } from '../config.js';

const processedTweets = new Set<string>();

export function hasProcessed(tweetId: string): boolean {
  return processedTweets.has(tweetId);
}

export function clearProcessed(): void {
  processedTweets.clear();
}

export async function handlePublishJob(
  job: any,
  clients: Clients,
  session: AgentSession,
  config: Config,
): Promise<void> {
  // Extract postUrl, subnet, and optional agent info from job payload
  const memos = job.memos ?? [];
  let postUrl: string | undefined;
  let subnet: string | undefined;
  let agentName: string | undefined;
  let agentDescription: string | undefined;
  for (const memo of memos) {
    try {
      const content = typeof memo.content === 'string' ? JSON.parse(memo.content) : memo.content;
      if (content?.postUrl) postUrl = content.postUrl;
      if (content?.subnet) subnet = content.subnet;
      if (content?.agentName) agentName = content.agentName;
      if (content?.agentDescription) agentDescription = content.agentDescription;
    } catch {
      // Not JSON, skip
    }
  }

  if (!postUrl) {
    await job.reject('Missing postUrl in job payload');
    return;
  }

  if (!subnet) {
    await job.reject('Missing subnet in job payload');
    return;
  }

  // Get buyer identifier from ACP job (wallet address or entity ID)
  const buyerId = job.clientAddress ?? job.buyerAddress ?? job.client?.address ?? null;

  // Validate URL format
  if (!/(?:twitter\.com|x\.com)\/\w+\/status\/\d+/.test(postUrl)) {
    await job.reject(`Invalid X/Twitter URL: ${postUrl}`);
    return;
  }

  // Accept the job
  await job.accept('Processing X post for pod minting');

  // Extract tweet ID and check dedup
  const tweetId = extractTweetId(postUrl);
  if (processedTweets.has(tweetId)) {
    await job.reject(`Tweet ${tweetId} already processed`);
    return;
  }

  // Fetch tweet data
  console.log(`[Publish] Fetching tweet ${tweetId}...`);
  const tweet = await fetchTweet(tweetId);
  console.log(`[Publish] Tweet by @${tweet.authorUsername}: "${tweet.text.slice(0, 80)}..."`);

  // Mint pod on-chain
  console.log(`[Publish] Minting pod...`);
  const mintResult = await mintPod(clients);
  console.log(`[Publish] Pod minted: tx=${mintResult.txHash}, podId=${mintResult.podId}`);

  // Get or create buyer's Reppo profile if agent info provided
  let publishSession = session; // default to reppodant
  if (buyerId && agentName) {
    const buyerSession = await getOrCreateBuyerAgent(config, buyerId, agentName, agentDescription);
    if (buyerSession) {
      publishSession = buyerSession;
      console.log(`[Publish] Using buyer's Reppo profile: ${buyerSession.agentId}`);
    }
  }

  // Submit metadata to Reppo
  const title = tweet.text.length > 100 ? tweet.text.slice(0, 97) + '...' : tweet.text;
  await submitPodMetadata(publishSession, config, {
    txHash: mintResult.txHash,
    title,
    description: tweet.text,
    url: postUrl,
    imageURL: tweet.mediaUrls[0],
    tokenId: mintResult.podId !== undefined ? Number(mintResult.podId) : undefined,
    subnet,
  });

  // Mark as processed
  processedTweets.add(tweetId);

  // Build deliverable
  const basescanUrl = `https://basescan.org/tx/${mintResult.txHash}`;
  const deliverable: AcpDeliverable = {
    postUrl,
    subnet,
    txHash: mintResult.txHash,
    podId: mintResult.podId?.toString(),
    basescanUrl,
  };

  // Deliver result via ACP
  await job.deliver(deliverable);
  console.log(`[Publish] Job delivered: ${basescanUrl}`);
}
