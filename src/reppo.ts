import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import lockfile from 'proper-lockfile';
import { fetchJSON, withRetry, isRetryableError } from './lib/http.js';
import { createLogger } from './lib/logger.js';
import type { Config } from './config.js';
import type { AgentSession, RegisterAgentResponse, RegisterPodResponse, SubmitMetadataParams, SubnetsResponse } from './types.js';

const log = createLogger('reppo');
let SESSION_FILE = '';
let BUYER_SESSIONS_FILE = '';

export function initReppoFiles(dataDir: string): void {
  SESSION_FILE = join(dataDir, '.reppo-session.json');
  BUYER_SESSIONS_FILE = join(dataDir, '.reppo-buyer-sessions.json');
}

// Buyer sessions keyed by wallet address
type BuyerSessionMap = Record<string, AgentSession>;

export function loadSession(): AgentSession | null {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const data: AgentSession = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));
    if (data.agentId && data.accessToken) return data;
    return null;
  } catch {
    return null;
  }
}

function saveSession(session: AgentSession): void {
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
}

function loadBuyerSessions(): BuyerSessionMap {
  if (!existsSync(BUYER_SESSIONS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(BUYER_SESSIONS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

async function saveBuyerSession(buyerId: string, session: AgentSession): Promise<void> {
  let release: (() => Promise<void>) | undefined;
  try {
    // Create file if it doesn't exist
    if (!existsSync(BUYER_SESSIONS_FILE)) {
      writeFileSync(BUYER_SESSIONS_FILE, '{}', { mode: 0o600 });
    }
    
    release = await lockfile.lock(BUYER_SESSIONS_FILE, { retries: 3 });
    
    const sessions = loadBuyerSessions();
    sessions[buyerId] = session;
    writeFileSync(BUYER_SESSIONS_FILE, JSON.stringify(sessions, null, 2), { mode: 0o600 });
  } catch (err) {
    log.error({ err, buyerId }, 'Failed to save buyer session');
    throw err;
  } finally {
    if (release) await release();
  }
}

export function getBuyerSession(buyerId: string): AgentSession | null {
  const sessions = loadBuyerSessions();
  return sessions[buyerId] ?? null;
}

function getAuthHeaders(session: AgentSession): Record<string, string> {
  return { Authorization: `Bearer ${session.accessToken}` };
}

export async function registerAgent(
  config: Config,
  agentName: string,
  agentDescription: string,
): Promise<AgentSession> {
  const existing = loadSession();
  if (existing) {
    log.info({ agentId: existing.agentId }, 'Already registered');
    return existing;
  }

  log.info({ name: agentName }, 'Registering agent with Reppo...');
  const res = await withRetry(
    () => fetchJSON<RegisterAgentResponse>(`${config.REPPO_API_URL}/agents/register`, {
      method: 'POST',
      body: JSON.stringify({
        name: agentName,
        description: agentDescription,
      }),
    }),
    'registerAgent',
    { shouldRetry: isRetryableError },
  );

  const session: AgentSession = {
    agentId: res.data.id,
    accessToken: res.data.accessToken,
    walletAddress: res.data.walletAddress,
  };
  saveSession(session);
  log.info({ agentId: session.agentId, walletAddress: session.walletAddress }, 'Registered successfully');
  return session;
}

/**
 * Fetch available subnet configurations from Reppo.
 */
export async function getSubnets(config: Config): Promise<SubnetsResponse> {
  log.info('Fetching subnet configs from Reppo...');
  const data = await withRetry(
    () => fetchJSON<SubnetsResponse>(`${config.REPPO_API_URL}/agents/subnets`, {
      method: 'GET',
    }),
    'getSubnets',
    { shouldRetry: isRetryableError },
  );
  log.info({ count: Array.isArray(data) ? data.length : 0 }, 'Subnets fetched');
  return data;
}

/**
 * Get or create a Reppo profile for a buyer agent.
 * @param config - app config
 * @param buyerId - unique identifier for buyer (e.g. ACP wallet address)
 * @param name - agent name (required for new registrations)
 * @param description - agent description (required for new registrations)
 */
export async function getOrCreateBuyerAgent(
  config: Config,
  buyerId: string,
  name?: string,
  description?: string,
): Promise<AgentSession | null> {
  // Check if we already have a session for this buyer
  const existing = getBuyerSession(buyerId);
  if (existing) {
    log.info({ buyerId, agentId: existing.agentId }, 'Buyer already registered');
    return existing;
  }

  // Need name to register
  if (!name) {
    log.info({ buyerId }, 'No agentName provided, skipping profile creation');
    return null;
  }

  log.info({ buyerId, name }, 'Registering buyer agent...');
  const res = await withRetry(
    () => fetchJSON<RegisterAgentResponse>(`${config.REPPO_API_URL}/agents/register`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: description || name,
      }),
    }),
    'registerBuyerAgent',
    { shouldRetry: isRetryableError },
  );

  const session: AgentSession = {
    agentId: res.data.id,
    accessToken: res.data.accessToken,
    walletAddress: res.data.walletAddress,
  };
  await saveBuyerSession(buyerId, session);
  log.info({ buyerId, agentId: session.agentId }, 'Buyer registered successfully');
  return session;
}

export async function submitPodMetadata(
  session: AgentSession,
  config: Config,
  params: SubmitMetadataParams,
): Promise<RegisterPodResponse> {
  log.info({ agentId: session.agentId, subnet: params.subnet }, 'Submitting metadata to Reppo...');
  const data = await withRetry(
    () => fetchJSON<RegisterPodResponse>(
      `${config.REPPO_API_URL}/agents/${session.agentId}/pods`,
      {
        method: 'POST',
        headers: getAuthHeaders(session),
        body: JSON.stringify({
          name: params.title,
          description: params.description || params.title,
          url: params.url,
          platform: 'x',
          podMintTx: params.txHash,
          ...(params.tokenId !== undefined && { tokenId: Number(params.tokenId) }),
          ...(params.category && { category: params.category }),
          ...(params.imageUrl && { imageUrl: params.imageUrl }),
          ...(params.subnet && { subnetId: params.subnet }),
        }),
      },
    ),
    'submitPodMetadata',
    { shouldRetry: isRetryableError },
  );
  log.info({ podId: data.data?.id }, 'Metadata submitted');
  return data;
}
