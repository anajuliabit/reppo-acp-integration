import 'dotenv/config';

export interface Config {
  PRIVATE_KEY: string;
  ACP_ENTITY_ID: number;
  ACP_WALLET_ADDRESS: string;
  REPPO_API_URL: string;
  REPPO_AGENT_NAME: string;
  REPPO_AGENT_DESCRIPTION: string;
  TWITTER_BEARER_TOKEN: string;
  RPC_URL?: string;
  POLL_INTERVAL_MS: number;
  ACP_TESTNET: boolean;
  HEALTH_PORT: number;
}

const REQUIRED_VARS = [
  'PRIVATE_KEY',
  'ACP_ENTITY_ID',
  'ACP_WALLET_ADDRESS',
  'REPPO_API_URL',
  'REPPO_AGENT_NAME',
  'REPPO_AGENT_DESCRIPTION',
  'TWITTER_BEARER_TOKEN',
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
    ACP_WALLET_ADDRESS: walletAddress,
    REPPO_API_URL: process.env['REPPO_API_URL']!,
    REPPO_AGENT_NAME: process.env['REPPO_AGENT_NAME']!,
    REPPO_AGENT_DESCRIPTION: process.env['REPPO_AGENT_DESCRIPTION']!,
    TWITTER_BEARER_TOKEN: process.env['TWITTER_BEARER_TOKEN']!,
    RPC_URL: process.env['RPC_URL'] || undefined,
    POLL_INTERVAL_MS: parseInteger(process.env['POLL_INTERVAL_MS'], 'POLL_INTERVAL_MS', 10_000),
    ACP_TESTNET: process.env['ACP_TESTNET'] === 'true',
    HEALTH_PORT: parseInteger(process.env['HEALTH_PORT'], 'HEALTH_PORT', 3000),
  };
}
