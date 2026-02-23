import { TwitterApi } from 'twitter-api-v2';
import { TWITTER_URL_REGEX } from './constants.js';
import { withRetry } from './lib/http.js';
import { createLogger } from './lib/logger.js';
import type { TweetData } from './types.js';

const log = createLogger('twitter');
let _client: TwitterApi | null = null;

export function initTwitterClient(credentials: {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}): TwitterApi {
  _client = new TwitterApi(credentials);
  return _client;
}

function getClient(): TwitterApi {
  if (!_client) throw new Error('Twitter client not initialized. Call initTwitterClient() first.');
  return _client;
}

export function extractTweetId(url: string): string {
  const match = url.match(TWITTER_URL_REGEX);
  if (!match?.[1]) {
    throw new Error(`Invalid X/Twitter URL: ${url}`);
  }
  return match[1];
}

function isRetryableTwitterError(error: Error): boolean {
  const message = error.message.toLowerCase();
  if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) return true;
  if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) return true;
  if (message.includes('security token') || message.includes('expired')) return true;
  if (message.includes('network') || message.includes('timeout') || message.includes('econnreset')) return true;
  return false;
}

export async function fetchTweet(tweetId: string): Promise<TweetData> {
  log.info({ tweetId }, 'Fetching tweet...');
  
  const client = getClient();
  
  const tweet = await withRetry(
    async () => {
      const result = await client.v2.singleTweet(tweetId, {
        expansions: ['author_id', 'attachments.media_keys'],
        'tweet.fields': ['created_at', 'text', 'author_id'],
        'user.fields': ['username'],
        'media.fields': ['url', 'preview_image_url'],
      });
      return result;
    },
    'fetchTweet',
    { 
      shouldRetry: isRetryableTwitterError,
      maxRetries: 5,
      baseDelay: 2000,
    },
  );

  if (!tweet.data) {
    throw new Error(`Tweet ${tweetId} not found or not accessible`);
  }

  const author = tweet.includes?.users?.[0];
  const media = tweet.includes?.media ?? [];
  const mediaUrls = media
    .map((m) => m.url || m.preview_image_url)
    .filter((u): u is string => !!u);

  const result: TweetData = {
    id: tweet.data.id,
    text: tweet.data.text,
    authorId: tweet.data.author_id ?? author?.id ?? '',
    authorUsername: author?.username ?? '',
    createdAt: tweet.data.created_at,
    mediaUrls,
  };

  log.info({ 
    tweetId, 
    author: result.authorUsername, 
    textLength: result.text.length,
    mediaCount: mediaUrls.length,
  }, 'Tweet fetched');

  return result;
}
