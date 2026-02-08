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

export function loadConfig(): Config {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  return {
    PRIVATE_KEY: process.env['PRIVATE_KEY']!,
    ACP_ENTITY_ID: Number(process.env['ACP_ENTITY_ID']),
    ACP_WALLET_ADDRESS: process.env['ACP_WALLET_ADDRESS']!,
    REPPO_API_URL: process.env['REPPO_API_URL']!,
    REPPO_AGENT_NAME: process.env['REPPO_AGENT_NAME']!,
    REPPO_AGENT_DESCRIPTION: process.env['REPPO_AGENT_DESCRIPTION']!,
    TWITTER_BEARER_TOKEN: process.env['TWITTER_BEARER_TOKEN']!,
    RPC_URL: process.env['RPC_URL'] || undefined,
    POLL_INTERVAL_MS: Number(process.env['POLL_INTERVAL_MS'] || 10_000),
  };
}
