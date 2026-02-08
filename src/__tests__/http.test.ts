import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry } from '../lib/http.js';

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

    const result = await withRetry(fn, 'test', 3);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent fail'));

    await expect(withRetry(fn, 'test', 2)).rejects.toThrow('persistent fail');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
