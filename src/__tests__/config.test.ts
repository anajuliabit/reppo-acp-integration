import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  // Valid 32-byte private key (64 hex chars)
  const VALID_PRIVATE_KEY = '0x' + 'a'.repeat(64);
  const VALID_WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

  const requiredVars = {
    PRIVATE_KEY: VALID_PRIVATE_KEY,
    ACP_ENTITY_ID: '123',
    ACP_WALLET_ADDRESS: VALID_WALLET_ADDRESS,
    REPPO_API_URL: 'https://reppo.ai/api/v1',
    TWITTER_BEARER_TOKEN: 'test-bearer-token',
  };

  beforeEach(() => {
    // Reset env
    for (const key of Object.keys(requiredVars)) {
      delete process.env[key];
    }
    delete process.env['RPC_URL'];
    delete process.env['POLL_INTERVAL_MS'];
    delete process.env['HEALTH_PORT'];
    delete process.env['ACP_TESTNET'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('loads valid config from env vars', async () => {
    Object.assign(process.env, requiredVars);
    const { loadConfig } = await import('../config.js');
    const config = loadConfig();

    expect(config.PRIVATE_KEY).toBe(VALID_PRIVATE_KEY);
    expect(config.ACP_ENTITY_ID).toBe(123);
    expect(config.ACP_WALLET_ADDRESS).toBe(VALID_WALLET_ADDRESS);
    expect(config.REPPO_API_URL).toBe('https://reppo.ai/api/v1');
    expect(config.TWITTER_BEARER_TOKEN).toBe('test-bearer-token');
    expect(config.RPC_URL).toBeUndefined();
    expect(config.POLL_INTERVAL_MS).toBe(10_000);
    expect(config.HEALTH_PORT).toBe(3000);
    expect(config.ACP_TESTNET).toBe(false);
  });

  it('throws on missing required vars', async () => {
    // Only set some vars
    process.env['PRIVATE_KEY'] = VALID_PRIVATE_KEY;
    const { loadConfig } = await import('../config.js');

    expect(() => loadConfig()).toThrow('Missing required env vars');
  });

  it('uses optional defaults', async () => {
    Object.assign(process.env, requiredVars);
    process.env['POLL_INTERVAL_MS'] = '5000';
    process.env['RPC_URL'] = 'https://rpc.example.com';
    process.env['HEALTH_PORT'] = '8080';
    process.env['ACP_TESTNET'] = 'true';
    const { loadConfig } = await import('../config.js');
    const config = loadConfig();

    expect(config.POLL_INTERVAL_MS).toBe(5000);
    expect(config.RPC_URL).toBe('https://rpc.example.com');
    expect(config.HEALTH_PORT).toBe(8080);
    expect(config.ACP_TESTNET).toBe(true);
  });

  it('throws on invalid private key format', async () => {
    Object.assign(process.env, requiredVars);
    process.env['PRIVATE_KEY'] = '0xdeadbeef'; // Too short
    const { loadConfig } = await import('../config.js');

    expect(() => loadConfig()).toThrow('PRIVATE_KEY must be a 32-byte hex string');
  });

  it('throws on invalid wallet address format', async () => {
    Object.assign(process.env, requiredVars);
    process.env['ACP_WALLET_ADDRESS'] = 'not-an-address';
    const { loadConfig } = await import('../config.js');

    expect(() => loadConfig()).toThrow('ACP_WALLET_ADDRESS must be a valid Ethereum address');
  });

  it('throws on invalid entity ID', async () => {
    Object.assign(process.env, requiredVars);
    process.env['ACP_ENTITY_ID'] = 'not-a-number';
    const { loadConfig } = await import('../config.js');

    expect(() => loadConfig()).toThrow('Invalid integer for ACP_ENTITY_ID');
  });
});
