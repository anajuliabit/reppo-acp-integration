import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handlePublishJob } from '../handlers/publish.js';

// Mock dedup module
vi.mock('../lib/dedup.js', () => {
  const processed = new Set<string>();
  const minted = new Set<string>();
  const locks = new Set<string>();
  return {
    initDedup: vi.fn(),
    hasProcessed: (id: string) => processed.has(id),
    markProcessed: vi.fn(async (id: string) => { processed.add(id); }),
    acquireProcessingLock: vi.fn(async (id: string) => {
      if (locks.has(id)) return null;
      locks.add(id);
      return () => { locks.delete(id); };
    }),
    hasJobMinted: (id: string | number) => minted.has(String(id)),
    markJobMinted: vi.fn(async (id: string | number) => { minted.add(String(id)); }),
    getProcessedCount: () => processed.size,
    // For test reset
    _reset: () => { processed.clear(); minted.clear(); locks.clear(); },
  };
});

// Mock pending-jobs module
vi.mock('../lib/pending-jobs.js', () => ({
  initPendingJobs: vi.fn(),
  savePendingJob: vi.fn().mockResolvedValue(undefined),
  updatePendingJobStatus: vi.fn().mockResolvedValue(undefined),
  removePendingJob: vi.fn().mockResolvedValue(undefined),
  getPendingJobs: vi.fn().mockReturnValue([]),
  getPendingJob: vi.fn().mockReturnValue(undefined),
  recordPendingJobError: vi.fn().mockResolvedValue(undefined),
}));

// Mock logger
vi.mock('../lib/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

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
  getOrCreateBuyerAgent: vi.fn().mockResolvedValue(null),
  getSubnets: vi.fn().mockResolvedValue({ data: { privateSubnets: [] } }),
}));

// Mock pods module
vi.mock('../lib/pods.js', () => ({
  savePod: vi.fn().mockResolvedValue(undefined),
  getJobMint: vi.fn().mockResolvedValue(null),
}));

function createMockJob(postUrl?: string, subnet?: string, overrides?: Record<string, unknown>) {
  const content: Record<string, string> = {};
  if (postUrl) content.postUrl = postUrl;
  if (subnet) content.subnet = subnet;

  return {
    id: 'job-1',
    phase: undefined as number | undefined,
    memos: Object.keys(content).length > 0 ? [{ content: JSON.stringify(content) }] : [],
    accept: vi.fn().mockResolvedValue(undefined),
    reject: vi.fn().mockResolvedValue(undefined),
    deliver: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    createRequirement: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const mockClients = { account: { address: '0x1234567890abcdef1234567890abcdef12345678' } } as any;
const mockSession = { agentId: 'agent-1', accessToken: 'token-1' };
const mockConfig = {
  REPPO_API_URL: 'https://reppo.ai/api/v1',
} as any;

describe('handlePublishJob', () => {
  beforeEach(async () => {
    // Reset dedup state
    const dedup = await import('../lib/dedup.js');
    (dedup as any)._reset();
    vi.clearAllMocks();
  });

  it('processes a valid job end-to-end', async () => {
    const job = createMockJob('https://x.com/testuser/status/1234567890', 'crypto', { phase: 2 });

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(job.deliver).toHaveBeenCalledOnce();

    const deliverable = job.deliver.mock.calls[0][0];
    expect(deliverable.postUrl).toBe('https://x.com/testuser/status/1234567890');
    expect(deliverable.subnet).toBe('crypto');
    expect(deliverable.txHash).toBe('0xabc123');
    expect(deliverable.podId).toBe('42');
    expect(deliverable.basescanUrl).toBe('https://basescan.org/tx/0xabc123');
  });

  it('rejects job with missing postUrl', async () => {
    const job = createMockJob(undefined, 'crypto');

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(job.reject).toHaveBeenCalledWith('Missing postUrl in job payload');
    expect(job.accept).not.toHaveBeenCalled();
  });

  it('rejects job with missing subnet', async () => {
    const job = createMockJob('https://x.com/testuser/status/1234567890');

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(job.reject).toHaveBeenCalledWith('Missing subnet in job payload');
    expect(job.accept).not.toHaveBeenCalled();
  });

  it('rejects job with invalid URL', async () => {
    const job = createMockJob('https://example.com/not-a-tweet', 'crypto');

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(job.reject).toHaveBeenCalledWith('Invalid X/Twitter URL: https://example.com/not-a-tweet');
    expect(job.accept).not.toHaveBeenCalled();
  });

  it('deduplicates same tweet ID', async () => {
    const job1 = createMockJob('https://x.com/testuser/status/1234567890', 'crypto', { id: 'job-1', phase: 2 });
    const job2 = createMockJob('https://x.com/otheruser/status/1234567890', 'crypto', { id: 'job-2', phase: 2 });

    await handlePublishJob(job1 as any, mockClients, mockSession, mockConfig);
    expect(job1.deliver).toHaveBeenCalledOnce();

    await handlePublishJob(job2 as any, mockClients, mockSession, mockConfig);
    expect(job2.reject).toHaveBeenCalledWith('Tweet 1234567890 already processed');
  });
});
