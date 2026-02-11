import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Config {
  PRIVATE_KEY: string;
  ACP_ENTITY_ID: number;
  ACP_SIGNER_ENTITY_ID: number;
  ACP_WALLET_ADDRESS: string;
  REPPO_API_URL: string;
  TWITTER_API_KEY: string;
  TWITTER_API_SECRET: string;
  TWITTER_ACCESS_TOKEN: string;
  TWITTER_ACCESS_TOKEN_SECRET: string;
  RPC_URL?: string;
  POLL_INTERVAL_MS: number;
  ACP_TESTNET: boolean;
  HEALTH_PORT: number;
  DATA_DIR: string;
}

const REQUIRED_VARS = [
  'PRIVATE_KEY',
  'ACP_ENTITY_ID',
  'ACP_WALLET_ADDRESS',
  'REPPO_API_URL',
  'TWITTER_API_KEY',
  'TWITTER_API_SECRET',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_TOKEN_SECRET',
] as const;

function parseInteger(value: string | undefined, name: string, defaultValue?: number): number {
  if (!value && defaultValue !== undefined) return defaultValue;
  if (!value) throw new Error(`Missing required env var: ${name}`);
  
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer for ${name}: "${value}"`);
  }
  return parsed;
}

function validatePrivateKey(key: string): string {
  const normalized = key.startsWith('0x') ? key : `0x${key}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error('PRIVATE_KEY must be a 32-byte hex string (64 chars, optionally 0x-prefixed)');
  }
  return normalized;
}

function validateAddress(address: string, name: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(`${name} must be a valid Ethereum address (0x + 40 hex chars)`);
  }
  return address;
}

export function loadConfig(): Config {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  const privateKey = validatePrivateKey(process.env['PRIVATE_KEY']!);
  const walletAddress = validateAddress(process.env['ACP_WALLET_ADDRESS']!, 'ACP_WALLET_ADDRESS');

  return {
    PRIVATE_KEY: privateKey,
    ACP_ENTITY_ID: parseInteger(process.env['ACP_ENTITY_ID'], 'ACP_ENTITY_ID'),
    ACP_SIGNER_ENTITY_ID: parseInteger(process.env['ACP_SIGNER_ENTITY_ID'], 'ACP_SIGNER_ENTITY_ID', parseInteger(process.env['ACP_ENTITY_ID'], 'ACP_ENTITY_ID')),
    ACP_WALLET_ADDRESS: walletAddress,
    REPPO_API_URL: process.env['REPPO_API_URL']!,
    TWITTER_API_KEY: process.env['TWITTER_API_KEY']!,
    TWITTER_API_SECRET: process.env['TWITTER_API_SECRET']!,
    TWITTER_ACCESS_TOKEN: process.env['TWITTER_ACCESS_TOKEN']!,
    TWITTER_ACCESS_TOKEN_SECRET: process.env['TWITTER_ACCESS_TOKEN_SECRET']!,
    RPC_URL: process.env['RPC_URL'] || undefined,
    POLL_INTERVAL_MS: Math.max(1000, parseInteger(process.env['POLL_INTERVAL_MS'], 'POLL_INTERVAL_MS', 10_000)),
    ACP_TESTNET: process.env['ACP_TESTNET'] === 'true',
    HEALTH_PORT: parseInteger(process.env['HEALTH_PORT'], 'HEALTH_PORT', 3000),
    DATA_DIR: process.env['DATA_DIR'] || resolve(__dirname, '..'),
  };
}

export interface AcpAgentInfo {
  id: number;
  name: string;
  description: string;
  walletAddress: string;
}

export async function fetchAcpAgentInfo(walletAddress: string, testnet: boolean): Promise<AcpAgentInfo> {
  const baseUrl = testnet ? 'https://acpx.virtuals.gg' : 'https://acpx.virtuals.io';
  const url = `${baseUrl}/api/agents?filters[walletAddress]=${walletAddress}`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ACP agent info: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json() as { data: AcpAgentInfo[] };
  if (!data.data || data.data.length === 0) {
    throw new Error(`No agent found for wallet ${walletAddress}`);
  }
  
  const agent = data.data[0];
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description || agent.name,
    walletAddress: agent.walletAddress,
  };
}

// Get agent info by entity ID, falling back to hardcoded values if API fails
export async function fetchAcpAgentInfoById(entityId: number, testnet: boolean, walletAddress: string): Promise<AcpAgentInfo> {
  try {
    // Try to fetch by wallet first
    const agent = await fetchAcpAgentInfo(walletAddress, testnet);
    
    // If entity ID doesn't match, log warning and use hardcoded values
    if (agent.id !== entityId) {
      console.warn(`Entity mismatch: expected ${entityId}, got ${agent.id}. Using hardcoded values.`);
      return {
        id: entityId,
        name: 'Reppodant',
        description: '@reppodant on Virtuals Protocol ACP v2, accepts jobs to mint X posts as pods on Reppo',
        walletAddress,
      };
    }
    
    return agent;
  } catch (error) {
    // Fallback to hardcoded values
    console.warn(`Failed to fetch agent info, using hardcoded values: ${error}`);
    return {
      id: entityId,
      name: 'Reppodant',
      description: '@reppodant on Virtuals Protocol ACP v2, accepts jobs to mint X posts as pods on Reppo',
      walletAddress,
    };
  }
}
