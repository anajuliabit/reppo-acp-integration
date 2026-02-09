import { MAX_RETRIES, RETRY_BASE_DELAY } from '../constants.js';
import { createLogger } from './logger.js';

const log = createLogger('http');

export async function fetchJSON<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  });
  const text = await res.text();
  let data: T | string;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data as T;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  options: RetryOptions = {},
): Promise<T> {
  const { 
    maxRetries = MAX_RETRIES, 
    baseDelay = RETRY_BASE_DELAY,
    shouldRetry = () => true,
  } = options;
  
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      if (attempt >= maxRetries || !shouldRetry(lastError, attempt)) {
        break;
      }
      
      const delay = baseDelay * Math.pow(2, attempt - 1);
      log.warn({ attempt, maxRetries, label, delay, error: lastError.message }, 'Retrying operation');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError!;
}

/**
 * Determine if an error is retryable (network issues, rate limits, etc.)
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();
  // Network errors
  if (message.includes('fetch failed') || message.includes('network')) return true;
  // Rate limits
  if (message.includes('429') || message.includes('rate limit')) return true;
  // Temporary server errors
  if (message.includes('502') || message.includes('503') || message.includes('504')) return true;
  // RPC errors
  if (message.includes('timeout') || message.includes('econnreset')) return true;
  return false;
}
