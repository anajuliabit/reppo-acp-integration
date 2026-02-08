import { MAX_RETRIES, RETRY_BASE_DELAY } from '../constants.js';

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

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries: number = MAX_RETRIES,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
        console.error(`  Retry ${attempt}/${maxRetries} for ${label} (waiting ${delay}ms)...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}
