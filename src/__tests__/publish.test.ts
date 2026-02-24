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

function createMockJob(overrides?: Record<string, unknown>) {
  return {
    id: 'job-1',
    phase: undefined as number | undefined,
    memos: [] as { content: string }[],
    accept: vi.fn().mockResolvedValue(undefined),
    reject: vi.fn().mockResolvedValue(undefined),
    deliver: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    createRequirement: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function withMemo(job: ReturnType<typeof createMockJob>, content: Record<string, unknown>) {
  job.memos = [{ content: JSON.stringify(content) }];
  return job;
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

  it('processes a valid job end-to-end (single subnet)', async () => {
    const job = withMemo(createMockJob({ phase: 2 }), {
      postUrl: 'https://x.com/testuser/status/1234567890',
      subnet: 'crypto',
    });

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(job.deliver).toHaveBeenCalledOnce();

    const deliverable = job.deliver.mock.calls[0][0];
    expect(deliverable.postUrl).toBe('https://x.com/testuser/status/1234567890');
    expect(deliverable.subnets).toEqual(['crypto']);
    expect(deliverable.txHash).toBe('0xabc123');
    expect(deliverable.podId).toBe('42');
    expect(deliverable.basescanUrl).toBe('https://basescan.org/tx/0xabc123');
    expect(deliverable.failedSubnets).toBeUndefined();
  });

  it('rejects job with missing postUrl', async () => {
    const job = withMemo(createMockJob(), { subnet: 'crypto' });

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(job.reject).toHaveBeenCalledWith('Missing postUrl in job payload');
    expect(job.accept).not.toHaveBeenCalled();
  });

  it('rejects job with missing subnet', async () => {
    const job = withMemo(createMockJob(), {
      postUrl: 'https://x.com/testuser/status/1234567890',
    });

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(job.reject).toHaveBeenCalledWith('Missing subnet in job payload');
    expect(job.accept).not.toHaveBeenCalled();
  });

  it('rejects job with invalid URL', async () => {
    const job = withMemo(createMockJob(), {
      postUrl: 'https://example.com/not-a-tweet',
      subnet: 'crypto',
    });

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(job.reject).toHaveBeenCalledWith('Invalid X/Twitter URL: https://example.com/not-a-tweet');
    expect(job.accept).not.toHaveBeenCalled();
  });

  it('deduplicates same tweet ID', async () => {
    const job1 = withMemo(createMockJob({ id: 'job-1', phase: 2 }), {
      postUrl: 'https://x.com/testuser/status/1234567890',
      subnet: 'crypto',
    });
    const job2 = withMemo(createMockJob({ id: 'job-2', phase: 2 }), {
      postUrl: 'https://x.com/otheruser/status/1234567890',
      subnet: 'crypto',
    });

    await handlePublishJob(job1 as any, mockClients, mockSession, mockConfig);
    expect(job1.deliver).toHaveBeenCalledOnce();

    await handlePublishJob(job2 as any, mockClients, mockSession, mockConfig);
    expect(job2.reject).toHaveBeenCalledWith('Tweet 1234567890 already processed');
  });

  // === Multi-subnet tests ===

  it('accepts comma-separated subnets', async () => {
    const job = withMemo(createMockJob({ phase: 2 }), {
      postUrl: 'https://x.com/testuser/status/1111111111',
      subnet: 'crypto, defi',
    });

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(job.deliver).toHaveBeenCalledOnce();
    const deliverable = job.deliver.mock.calls[0][0];
    expect(deliverable.subnets).toEqual(['crypto', 'defi']);
    expect(deliverable.failedSubnets).toBeUndefined();
  });

  it('accepts subnets array', async () => {
    const job = withMemo(createMockJob({ phase: 2 }), {
      postUrl: 'https://x.com/testuser/status/2222222222',
      subnets: ['crypto', 'defi', 'nft'],
    });

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(job.deliver).toHaveBeenCalledOnce();
    const deliverable = job.deliver.mock.calls[0][0];
    expect(deliverable.subnets).toEqual(['crypto', 'defi', 'nft']);
  });

  it('rejects job when any subnet is invalid', async () => {
    const { getSubnets } = await import('../reppo.js');
    (getSubnets as any).mockResolvedValueOnce({
      data: {
        privateSubnets: [
          { id: '1', subnet: 'crypto' },
          { id: '2', subnet: 'defi' },
        ],
      },
    });

    const job = withMemo(createMockJob({ phase: 2 }), {
      postUrl: 'https://x.com/testuser/status/3333333333',
      subnets: ['crypto', 'nonexistent'],
    });

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(job.reject).toHaveBeenCalled();
    expect(job.reject.mock.calls[0][0]).toContain('Invalid subnet "nonexistent"');
    expect(job.deliver).not.toHaveBeenCalled();
  });

  it('deduplicates resolved subnet IDs', async () => {
    const { getSubnets } = await import('../reppo.js');
    (getSubnets as any).mockResolvedValueOnce({
      data: {
        privateSubnets: [
          { id: '1', subnet: 'crypto' },
          { id: '2', subnet: 'defi' },
        ],
      },
    });

    const { submitPodMetadata } = await import('../reppo.js');

    const job = withMemo(createMockJob({ phase: 2 }), {
      postUrl: 'https://x.com/testuser/status/4444444444',
      subnets: ['crypto', '1'], // same subnet by name and ID
    });

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(job.deliver).toHaveBeenCalledOnce();
    const deliverable = job.deliver.mock.calls[0][0];
    // Should deduplicate to a single subnet ID
    expect(deliverable.subnets).toEqual(['1']);
    // submitPodMetadata should only be called once for the deduped subnet
    expect(submitPodMetadata).toHaveBeenCalledTimes(1);
  });

  it('handles partial metadata failure', async () => {
    const { submitPodMetadata } = await import('../reppo.js');
    let callCount = 0;
    (submitPodMetadata as any).mockImplementation(async (_s: any, _c: any, params: any) => {
      callCount++;
      if (params.subnetId === 'fail-subnet') {
        throw new Error('API error');
      }
      return { data: { id: 'pod-1' } };
    });

    const job = withMemo(createMockJob({ phase: 2 }), {
      postUrl: 'https://x.com/testuser/status/5555555555',
      subnets: ['good-subnet', 'fail-subnet'],
    });

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    // Should still deliver (pod is minted on-chain)
    expect(job.deliver).toHaveBeenCalledOnce();
    const deliverable = job.deliver.mock.calls[0][0];
    expect(deliverable.subnets).toEqual(['good-subnet']);
    expect(deliverable.failedSubnets).toEqual(['fail-subnet']);
  });

  it('rejects job with too many subnets', async () => {
    const job = withMemo(createMockJob({ phase: 2 }), {
      postUrl: 'https://x.com/testuser/status/6666666666',
      subnets: Array.from({ length: 11 }, (_, i) => `subnet-${i}`),
    });

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(job.reject).toHaveBeenCalled();
    expect(job.reject.mock.calls[0][0]).toContain('Too many subnets');
    expect(job.deliver).not.toHaveBeenCalled();
  });

  it('submits metadata to all subnets with same txHash/podId', async () => {
    const { submitPodMetadata } = await import('../reppo.js');
    (submitPodMetadata as any).mockResolvedValue({ data: { id: 'pod-1' } });

    const job = withMemo(createMockJob({ phase: 2 }), {
      postUrl: 'https://x.com/testuser/status/7777777777',
      subnets: ['subnet-a', 'subnet-b'],
    });

    await handlePublishJob(job as any, mockClients, mockSession, mockConfig);

    expect(submitPodMetadata).toHaveBeenCalledTimes(2);
    const call1 = (submitPodMetadata as any).mock.calls[0][2];
    const call2 = (submitPodMetadata as any).mock.calls[1][2];
    // Same txHash and tokenId for both
    expect(call1.txHash).toBe(call2.txHash);
    expect(call1.tokenId).toBe(call2.tokenId);
    // Different subnetIds
    expect(call1.subnetId).toBe('subnet-a');
    expect(call2.subnetId).toBe('subnet-b');
  });
});
