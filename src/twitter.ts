import TwitterApi from 'twitter-api-v2';
import type { TweetData } from './types.js';

let _client: TwitterApi | null = null;

export function initTwitterClient(bearerToken: string): TwitterApi {
  _client = new TwitterApi(bearerToken);
  return _client;
}

function getClient(): TwitterApi {
  if (!_client) throw new Error('Twitter client not initialized. Call initTwitterClient() first.');
  return _client;
}

export function extractTweetId(url: string): string {
  const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
  if (!match?.[1]) {
    throw new Error(`Invalid X/Twitter URL: ${url}`);
  }
  return match[1];
}

export async function fetchTweet(tweetId: string): Promise<TweetData> {
  const client = getClient();
  const tweet = await client.v2.singleTweet(tweetId, {
    expansions: ['author_id', 'attachments.media_keys'],
    'tweet.fields': ['created_at', 'text', 'author_id'],
    'user.fields': ['username'],
    'media.fields': ['url', 'preview_image_url'],
  });

  const author = tweet.includes?.users?.[0];
  const media = tweet.includes?.media ?? [];
  const mediaUrls = media
    .map((m) => m.url || m.preview_image_url)
    .filter((u): u is string => !!u);

  return {
    id: tweet.data.id,
    text: tweet.data.text,
    authorId: tweet.data.author_id ?? author?.id ?? '',
    authorUsername: author?.username ?? '',
    createdAt: tweet.data.created_at,
    mediaUrls,
  };
}
