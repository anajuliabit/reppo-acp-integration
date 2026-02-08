import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handlePublishJob, hasProcessed, clearProcessed } from '../handlers/publish.js';

// Mock twitter module
vi.mock('../twitter.js', () => ({
  extractTweetId: (url: string) => {
    const match = url.match(/status\/(\d+)/);
    return match?.[1] ?? '';
  },
  fetchTweet: vi.fn().mockResolvedValue({
    id: '1234567890',
    text: 'This is a test tweet about AI agents',
    authorId: '111',
    authorUsername: 'testuser',
    createdAt: '2025-01-01T00:00:00Z',
    mediaUrls: ['https://pbs.twimg.com/media/test.jpg'],
  }),
}));

// Mock chain module
vi.mock('../chain.js', () => ({
  mintPod: vi.fn().mockResolvedValue({
    txHash: '0xabc123' as `0x${string}`,
    receipt: { status: 'success', blockNumber: 100n },
    podId: 42n,
  }),
}));

// Mock reppo module
vi.mock('../reppo.js', () => ({
  submitPodMetadata: vi.fn().mockResolvedValue({ data: { id: 'pod-1' } }),
}));

function createMockJob(postUrl?: string) {
  return {
    id: 'job-1',
    memos: postUrl ? [{ content: JSON.stringify({ postUrl }) }] : [],
    accept: vi.fn().mockResolvedValue(undefined),
    reject: vi.fn().mockResolvedValue(undefined),
    deliver: vi.fn().mockResolvedValue(undefined),
  };
}

const mockClients = {} as any;
const mockSession = { agentId: 'agent-1', accessToken: 'token-1' };
const mockConfig = {
  REPPO_API_URL: 'https://reppo.ai/api/v1',
} as any;

describe('handlePublishJob', () => {
  beforeEach(() => {
    clearProcessed();
    vi.clearAllMocks();
  });

  it('processes a valid job end-to-end', async () => {
    const job = createMockJob('https://x.com/testuser/status/1234567890');

    await handlePublishJob(job, mockClients, mockSession, mockConfig);

    expect(job.accept).toHaveBeenCalledWith('Processing X post for pod minting');
    expect(job.deliver).toHaveBeenCalledOnce();

    const deliverable = job.deliver.mock.calls[0][0];
    expect(deliverable.postUrl).toBe('https://x.com/testuser/status/1234567890');
    expect(deliverable.txHash).toBe('0xabc123');
    expect(deliverable.podId).toBe('42');
    expect(deliverable.basescanUrl).toBe('https://basescan.org/tx/0xabc123');
  });

  it('rejects job with missing postUrl', async () => {
    const job = createMockJob();

    await handlePublishJob(job, mockClients, mockSession, mockConfig);

    expect(job.reject).toHaveBeenCalledWith('Missing postUrl in job payload');
    expect(job.accept).not.toHaveBeenCalled();
  });

  it('rejects job with invalid URL', async () => {
    const job = createMockJob('https://example.com/not-a-tweet');

    await handlePublishJob(job, mockClients, mockSession, mockConfig);

    expect(job.reject).toHaveBeenCalledWith('Invalid X/Twitter URL: https://example.com/not-a-tweet');
    expect(job.accept).not.toHaveBeenCalled();
  });

  it('deduplicates same tweet ID', async () => {
    const job1 = createMockJob('https://x.com/testuser/status/1234567890');
    const job2 = createMockJob('https://x.com/otheruser/status/1234567890');

    await handlePublishJob(job1, mockClients, mockSession, mockConfig);
    expect(job1.deliver).toHaveBeenCalledOnce();
    expect(hasProcessed('1234567890')).toBe(true);

    await handlePublishJob(job2, mockClients, mockSession, mockConfig);
    expect(job2.reject).toHaveBeenCalledWith('Tweet 1234567890 already processed');
  });
});
