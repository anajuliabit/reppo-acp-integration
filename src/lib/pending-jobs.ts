import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import lockfile from 'proper-lockfile';
import { createLogger } from './logger.js';
import type { PendingJob, PendingJobStatus } from '../types.js';

const log = createLogger('pending-jobs');
let PENDING_FILE = '';
const COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// In-memory cache
const jobs = new Map<string, PendingJob>();

interface PendingJobsState {
  jobs: PendingJob[];
  lastUpdated: string;
}

function loadState(): PendingJobsState {
  if (!existsSync(PENDING_FILE)) {
    return { jobs: [], lastUpdated: new Date().toISOString() };
  }
  try {
    return JSON.parse(readFileSync(PENDING_FILE, 'utf-8'));
  } catch (err) {
    log.warn({ err }, 'Failed to load pending jobs state, starting fresh');
    return { jobs: [], lastUpdated: new Date().toISOString() };
  }
}

function saveState(state: PendingJobsState): void {
  writeFileSync(PENDING_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function persist(): void {
  const state: PendingJobsState = {
    jobs: Array.from(jobs.values()),
    lastUpdated: new Date().toISOString(),
  };
  saveState(state);
}

async function persistWithLock(): Promise<void> {
  let release: (() => Promise<void>) | undefined;
  try {
    if (!existsSync(PENDING_FILE)) {
      saveState({ jobs: [], lastUpdated: new Date().toISOString() });
    }
    release = await lockfile.lock(PENDING_FILE, { retries: 3 });
    persist();
  } catch (err) {
    log.error({ err }, 'Failed to persist pending jobs');
  } finally {
    if (release) await release();
  }
}

/**
 * Initialize pending jobs from disk, purge old completed entries
 */
export function initPendingJobs(dataDir: string): void {
  PENDING_FILE = join(dataDir, '.reppo-pending-jobs.json');
  const state = loadState();

  const now = Date.now();
  for (const job of state.jobs) {
    // Purge completed jobs older than 7 days
    if (job.status === 'completed') {
      const age = now - new Date(job.updatedAt).getTime();
      if (age > COMPLETED_TTL_MS) continue;
    }
    // Migrate legacy subnet → subnets
    if (!job.subnets && (job as any).subnet) {
      job.subnets = [(job as any).subnet];
      delete (job as any).subnet;
    }
    jobs.set(job.jobId, job);
  }

  log.info({ total: jobs.size }, 'Loaded pending jobs');
}

/**
 * Upsert a pending job to the map and persist
 */
export async function savePendingJob(job: PendingJob): Promise<void> {
  jobs.set(job.jobId, job);
  await persistWithLock();
  log.info({ jobId: job.jobId, status: job.status }, 'Pending job saved');
}

/**
 * Update status and optional extra fields on a pending job
 */
export async function updatePendingJobStatus(
  jobId: string,
  status: PendingJobStatus,
  extra?: Partial<PendingJob>,
): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = status;
  job.updatedAt = new Date().toISOString();
  if (extra) Object.assign(job, extra);

  await persistWithLock();
  log.info({ jobId, status }, 'Pending job status updated');
}

/**
 * Remove a pending job (after successful completion)
 */
export async function removePendingJob(jobId: string): Promise<void> {
  if (!jobs.has(jobId)) return;
  jobs.delete(jobId);
  await persistWithLock();
  log.info({ jobId }, 'Pending job removed');
}

/**
 * Get all non-completed pending jobs (for retry on startup)
 */
export function getPendingJobs(): PendingJob[] {
  return Array.from(jobs.values()).filter((j) => j.status !== 'completed');
}

/**
 * Get a single pending job by ID
 */
export function getPendingJob(jobId: string): PendingJob | undefined {
  return jobs.get(jobId);
}

/**
 * Record an error on a pending job (increment retryCount, set lastError)
 */
export async function recordPendingJobError(jobId: string, msg: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  job.retryCount += 1;
  job.lastError = msg;
  job.updatedAt = new Date().toISOString();

  await persistWithLock();
  log.warn({ jobId, retryCount: job.retryCount, error: msg }, 'Pending job error recorded');
}
