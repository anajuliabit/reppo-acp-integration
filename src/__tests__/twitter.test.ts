import { describe, it, expect } from 'vitest';
import { extractTweetId } from '../twitter.js';

describe('extractTweetId', () => {
  it('extracts ID from x.com URL', () => {
    expect(extractTweetId('https://x.com/user/status/1234567890')).toBe('1234567890');
  });

  it('extracts ID from twitter.com URL', () => {
    expect(extractTweetId('https://twitter.com/user/status/9876543210')).toBe('9876543210');
  });

  it('extracts ID from URL with query params', () => {
    expect(extractTweetId('https://x.com/user/status/1234567890?s=20')).toBe('1234567890');
  });

  it('throws on invalid URL', () => {
    expect(() => extractTweetId('https://example.com/not-a-tweet')).toThrow('Invalid X/Twitter URL');
  });

  it('throws on empty string', () => {
    expect(() => extractTweetId('')).toThrow('Invalid X/Twitter URL');
  });
});
