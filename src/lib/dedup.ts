import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import lockfile from 'proper-lockfile';
import { createLogger } from './logger.js';
import type { DedupState } from '../types.js';

const log = createLogger('dedup');
let DEDUP_FILE = '';
const MAX_ENTRIES = 10_000; // Prevent unbounded growth

// In-memory cache for fast lookups
let cache: Set<string> | null = null;

// Job processing locks (prevent concurrent processing of same tweet)
const processingLocks = new Map<string, Promise<void>>();

// Jobs that have been minted (prevent double-minting across restarts)
const mintedJobs = new Set<string>();

function loadState(): DedupState {
  if (!existsSync(DEDUP_FILE)) {
    return { processedTweets: [], lastUpdated: new Date().toISOString() };
  }
  try {
    return JSON.parse(readFileSync(DEDUP_FILE, 'utf-8'));
  } catch (err) {
    log.warn({ err }, 'Failed to load dedup state, starting fresh');
    return { processedTweets: [], lastUpdated: new Date().toISOString() };
  }
}

function saveState(state: DedupState): void {
  writeFileSync(DEDUP_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * Initialize dedup cache from disk
 */
export function initDedup(dataDir?: string): void {
  if (dataDir) {
    DEDUP_FILE = join(dataDir, '.reppo-dedup.json');
  }
  const state = loadState();
  cache = new Set(state.processedTweets);
  // Load minted jobs from disk
  if (state.mintedJobs) {
    for (const id of state.mintedJobs) mintedJobs.add(id);
  }
  log.info({ tweets: cache.size, jobs: mintedJobs.size }, 'Loaded dedup state');
}

/**
 * Check if a tweet has been processed (fast, from memory)
 */
export function hasProcessed(tweetId: string): boolean {
  if (!cache) initDedup();
  return cache!.has(tweetId);
}

/**
 * Mark a tweet as processed (persists to disk with file locking)
 */
export async function markProcessed(tweetId: string): Promise<void> {
  if (!cache) initDedup();
  
  // Add to memory immediately
  cache!.add(tweetId);
  
  // Persist to disk with locking
  let release: (() => Promise<void>) | undefined;
  try {
    // Create file if it doesn't exist
    if (!existsSync(DEDUP_FILE)) {
      saveState({ processedTweets: [], lastUpdated: new Date().toISOString() });
    }
    
    release = await lockfile.lock(DEDUP_FILE, { retries: 3 });

    const state = loadState();
    const existing = new Set(state.processedTweets);
    if (!existing.has(tweetId)) {
      state.processedTweets.push(tweetId);

      // Trim old entries if needed
      if (state.processedTweets.length > MAX_ENTRIES) {
        state.processedTweets = state.processedTweets.slice(-MAX_ENTRIES);
      }

      state.lastUpdated = new Date().toISOString();
      saveState(state);
    }
  } catch (err) {
    log.error({ err, tweetId }, 'Failed to persist dedup state');
    // Don't throw - in-memory state is still updated
  } finally {
    if (release) await release();
  }
}

/**
 * Acquire a processing lock for a tweet (prevents concurrent processing)
 * Returns a release function, or null if already being processed
 */
export async function acquireProcessingLock(tweetId: string): Promise<(() => void) | null> {
  // Check if already being processed
  if (processingLocks.has(tweetId)) {
    log.warn({ tweetId }, 'Tweet already being processed');
    return null;
  }
  
  // Create a lock promise
  let releaseFn: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  
  processingLocks.set(tweetId, lockPromise);
  
  return () => {
    processingLocks.delete(tweetId);
    releaseFn();
  };
}

/**
 * Check if a job has already been minted
 */
export function hasJobMinted(jobId: string | number): boolean {
  return mintedJobs.has(String(jobId));
}

/**
 * Mark a job as minted (in-memory + persisted in dedup file)
 */
export async function markJobMinted(jobId: string | number): Promise<void> {
  const id = String(jobId);
  mintedJobs.add(id);
  
  // Also persist to disk
  let release: (() => Promise<void>) | undefined;
  try {
    if (!existsSync(DEDUP_FILE)) {
      saveState({ processedTweets: [], lastUpdated: new Date().toISOString() });
    }
    release = await lockfile.lock(DEDUP_FILE, { retries: 3 });
    const state = loadState();
    if (!state.mintedJobs) state.mintedJobs = [];
    if (!state.mintedJobs.includes(id)) {
      state.mintedJobs.push(id);
      state.lastUpdated = new Date().toISOString();
      saveState(state);
    }
  } catch (err) {
    log.error({ err, jobId: id }, 'Failed to persist minted job');
  } finally {
    if (release) await release();
  }
}

/**
 * Get count of processed tweets
 */
export function getProcessedCount(): number {
  if (!cache) initDedup();
  return cache!.size;
}
