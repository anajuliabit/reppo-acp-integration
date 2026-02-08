import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  const requiredVars = {
    PRIVATE_KEY: '0xdeadbeef',
    ACP_ENTITY_ID: '123',
    ACP_WALLET_ADDRESS: '0x1234567890abcdef1234567890abcdef12345678',
    REPPO_API_URL: 'https://reppo.ai/api/v1',
    REPPO_AGENT_NAME: 'reppodant',
    REPPO_AGENT_DESCRIPTION: 'Test agent',
    TWITTER_BEARER_TOKEN: 'test-bearer-token',
  };

  beforeEach(() => {
    // Reset env
    for (const key of Object.keys(requiredVars)) {
      delete process.env[key];
    }
    delete process.env['RPC_URL'];
    delete process.env['POLL_INTERVAL_MS'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('loads valid config from env vars', async () => {
    Object.assign(process.env, requiredVars);
    const { loadConfig } = await import('../config.js');
    const config = loadConfig();

    expect(config.PRIVATE_KEY).toBe('0xdeadbeef');
    expect(config.ACP_ENTITY_ID).toBe(123);
    expect(config.ACP_WALLET_ADDRESS).toBe(requiredVars.ACP_WALLET_ADDRESS);
    expect(config.REPPO_API_URL).toBe('https://reppo.ai/api/v1');
    expect(config.REPPO_AGENT_NAME).toBe('reppodant');
    expect(config.TWITTER_BEARER_TOKEN).toBe('test-bearer-token');
    expect(config.RPC_URL).toBeUndefined();
    expect(config.POLL_INTERVAL_MS).toBe(10_000);
  });

  it('throws on missing required vars', async () => {
    // Only set some vars
    process.env['PRIVATE_KEY'] = '0xdeadbeef';
    const { loadConfig } = await import('../config.js');

    expect(() => loadConfig()).toThrow('Missing required env vars');
  });

  it('uses optional defaults', async () => {
    Object.assign(process.env, requiredVars);
    process.env['POLL_INTERVAL_MS'] = '5000';
    process.env['RPC_URL'] = 'https://rpc.example.com';
    const { loadConfig } = await import('../config.js');
    const config = loadConfig();

    expect(config.POLL_INTERVAL_MS).toBe(5000);
    expect(config.RPC_URL).toBe('https://rpc.example.com');
  });
});
