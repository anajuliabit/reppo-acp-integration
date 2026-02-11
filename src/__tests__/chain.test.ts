import { describe, it, expect, vi, beforeEach } from 'vitest';
import { keccak256, toHex, pad, type TransactionReceipt } from 'viem';
import { extractPodId, createClients } from '../chain.js';

// Mock logger
vi.mock('../lib/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock http module (withRetry, isRetryableError)
vi.mock('../lib/http.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  isRetryableError: () => false,
}));

/**
 * Build a raw ERC-721 Transfer(address,address,uint256) log entry.
 * Transfer event: all three args are indexed → topics only, data is empty.
 */
function buildTransferLog(from: string, to: string, tokenId: bigint) {
  const eventSig = keccak256(toHex('Transfer(address,address,uint256)'));
  return {
    data: '0x' as `0x${string}`,
    topics: [
      eventSig,
      pad(from as `0x${string}`, { size: 32 }),
      pad(to as `0x${string}`, { size: 32 }),
      pad(toHex(tokenId), { size: 32 }),
    ] as [`0x${string}`, ...`0x${string}`[]],
    address: '0xcfF0511089D0Fbe92E1788E4aFFF3E7930b3D47c' as `0x${string}`,
    blockHash: ('0x' + '0'.repeat(64)) as `0x${string}`,
    blockNumber: 100n,
    logIndex: 0,
    transactionHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
    transactionIndex: 0,
    removed: false,
  };
}

describe('extractPodId', () => {
  it('extracts tokenId from Transfer event in receipt logs', () => {
    const log = buildTransferLog(
      '0x0000000000000000000000000000000000000000',
      '0x1234567890abcdef1234567890abcdef12345678',
      42n,
    );

    const receipt = { logs: [log] } as unknown as TransactionReceipt;
    expect(extractPodId(receipt)).toBe(42n);
  });

  it('returns undefined when no Transfer event is present', () => {
    const receipt = {
      logs: [{
        data: '0x' as `0x${string}`,
        topics: [('0x' + 'f'.repeat(64)) as `0x${string}`],
        address: '0xcfF0511089D0Fbe92E1788E4aFFF3E7930b3D47c' as `0x${string}`,
        blockHash: ('0x' + '0'.repeat(64)) as `0x${string}`,
        blockNumber: 100n,
        logIndex: 0,
        transactionHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        transactionIndex: 0,
        removed: false,
      }],
    } as unknown as TransactionReceipt;

    expect(extractPodId(receipt)).toBeUndefined();
  });

  it('returns undefined for empty logs', () => {
    const receipt = { logs: [] } as unknown as TransactionReceipt;
    expect(extractPodId(receipt)).toBeUndefined();
  });

  it('handles large pod IDs without precision loss', () => {
    const largePodId = 2n ** 128n + 1n;
    const log = buildTransferLog(
      '0x0000000000000000000000000000000000000000',
      '0x1234567890abcdef1234567890abcdef12345678',
      largePodId,
    );

    const receipt = { logs: [log] } as unknown as TransactionReceipt;
    expect(extractPodId(receipt)).toBe(largePodId);
  });
});

describe('createClients', () => {
  it('creates account, public, and wallet clients', () => {
    const pk = '0x' + 'a'.repeat(64);
    const clients = createClients(pk);

    expect(clients.account).toBeDefined();
    expect(clients.account.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(clients.publicClient).toBeDefined();
    expect(clients.walletClient).toBeDefined();
  });

  it('accepts custom RPC URL', () => {
    const pk = '0x' + 'a'.repeat(64);
    const clients = createClients(pk, 'https://rpc.example.com');

    expect(clients.publicClient).toBeDefined();
    expect(clients.walletClient).toBeDefined();
  });
});

