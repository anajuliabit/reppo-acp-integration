import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry } from '../lib/http.js';

// Mock logger
vi.mock('../lib/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('withRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries on failure then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, 'test', { maxRetries: 3, baseDelay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent fail'));

    await expect(withRetry(fn, 'test', { maxRetries: 2, baseDelay: 10 })).rejects.toThrow('persistent fail');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('respects shouldRetry callback', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('non-retryable'));

    await expect(
      withRetry(fn, 'test', { 
        maxRetries: 3, 
        baseDelay: 10,
        shouldRetry: () => false, // Don't retry
      })
    ).rejects.toThrow('non-retryable');
    
    expect(fn).toHaveBeenCalledTimes(1); // Only one attempt
  });
});
