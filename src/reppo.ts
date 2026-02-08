import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fetchJSON } from './lib/http.js';
import type { Config } from './config.js';
import type { AgentSession, RegisterAgentResponse, RegisterPodResponse, SubmitMetadataParams } from './types.js';

const SESSION_FILE = resolve('.reppo-session.json');

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
        category: 'AGENTS',
        podMintTx: params.txHash,
        ...(params.tokenId !== undefined && { tokenId: params.tokenId }),
        ...(params.imageURL && { imageURL: params.imageURL }),
      }),
    },
  );
  console.log('Metadata submitted');
  return data;
}
