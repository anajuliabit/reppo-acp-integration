import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fetchJSON } from './lib/http.js';
import type { Config } from './config.js';
import type { AgentSession, RegisterAgentResponse, RegisterPodResponse, SubmitMetadataParams } from './types.js';

const SESSION_FILE = resolve('.reppo-session.json');
const BUYER_SESSIONS_FILE = resolve('.reppo-buyer-sessions.json');

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

function saveBuyerSession(buyerId: string, session: AgentSession): void {
  const sessions = loadBuyerSessions();
  sessions[buyerId] = session;
  writeFileSync(BUYER_SESSIONS_FILE, JSON.stringify(sessions, null, 2), { mode: 0o600 });
}

export function getBuyerSession(buyerId: string): AgentSession | null {
  const sessions = loadBuyerSessions();
  return sessions[buyerId] ?? null;
}

function getAuthHeaders(session: AgentSession): Record<string, string> {
  return { Authorization: `Bearer ${session.accessToken}` };
}

export async function registerAgent(config: Config): Promise<AgentSession> {
  const existing = loadSession();
  if (existing) {
    console.log(`Already registered as agent ${existing.agentId}`);
    return existing;
  }

  console.log('Registering agent with Reppo...');
  const res = await fetchJSON<RegisterAgentResponse>(`${config.REPPO_API_URL}/agents/register`, {
    method: 'POST',
    body: JSON.stringify({
      name: config.REPPO_AGENT_NAME,
      description: config.REPPO_AGENT_DESCRIPTION,
    }),
  });

  const session: AgentSession = {
    agentId: res.data.id,
    accessToken: res.data.accessToken,
  };
  saveSession(session);
  console.log(`Registered as agent ${session.agentId}`);
  return session;
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
    console.log(`[Reppo] Buyer ${buyerId} already registered as agent ${existing.agentId}`);
    return existing;
  }

  // Need name to register
  if (!name) {
    console.log(`[Reppo] No agentName provided for new buyer ${buyerId}, skipping profile creation`);
    return null;
  }

  console.log(`[Reppo] Registering buyer ${buyerId} as "${name}"...`);
  const res = await fetchJSON<RegisterAgentResponse>(`${config.REPPO_API_URL}/agents/register`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: description || name,
    }),
  });

  const session: AgentSession = {
    agentId: res.data.id,
    accessToken: res.data.accessToken,
  };
  saveBuyerSession(buyerId, session);
  console.log(`[Reppo] Buyer registered as agent ${session.agentId}`);
  return session;
}

export async function submitPodMetadata(
  session: AgentSession,
  config: Config,
  params: SubmitMetadataParams,
): Promise<RegisterPodResponse> {
  console.log('Submitting metadata to Reppo...');
  const data = await fetchJSON<RegisterPodResponse>(
    `${config.REPPO_API_URL}/agents/${session.agentId}/pods`,
    {
      method: 'POST',
      headers: getAuthHeaders(session),
      body: JSON.stringify({
        name: params.title,
        description: params.description || params.title,
        url: params.url,
        platform: 'x',
        subnet: params.subnet,
        podMintTx: params.txHash,
        ...(params.tokenId !== undefined && { tokenId: params.tokenId }),
        ...(params.imageURL && { imageURL: params.imageURL }),
      }),
    },
  );
  console.log('Metadata submitted');
  return data;
}
