import { createPublicClient, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { createLogger } from './logger.js';

const log = createLogger('verify');

/**
 * Verify that a mint transaction was successful on-chain.
 * Returns true if the tx exists and succeeded (status = 'success').
 */
export async function verifyMintTx(txHash: string, testnet = false): Promise<boolean> {
  const chain = testnet ? baseSepolia : base;
  const client = createPublicClient({
    chain,
    transport: http(),
  });

  try {
    const receipt = await client.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });

    if (receipt.status === 'success') {
      log.info({ txHash, blockNumber: receipt.blockNumber.toString() }, 'Mint tx verified');
      return true;
    }

    log.warn({ txHash, status: receipt.status }, 'Mint tx failed on-chain');
    return false;
  } catch (err) {
    log.error({ txHash, error: (err as Error).message }, 'Failed to verify mint tx');
    return false;
  }
}
