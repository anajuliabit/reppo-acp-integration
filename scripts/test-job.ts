/**
 * Test script — acts as a buyer agent to send a job to @reppodant.
 *
 * Usage:
 *   BUYER_PRIVATE_KEY=0x... \
 *   BUYER_ENTITY_ID=123 \
 *   BUYER_WALLET_ADDRESS=0x... \
 *   PROVIDER_WALLET_ADDRESS=0x... \
 *   npx tsx scripts/test-job.ts <post-url> [subnet]
 *
 * Example:
 *   npx tsx scripts/test-job.ts https://x.com/VitalikButerin/status/1234567890
 *   npx tsx scripts/test-job.ts https://x.com/VitalikButerin/status/1234567890 ai
 *
 * Set ACP_TESTNET=true to use Base Sepolia instead of Base mainnet.
 */

import AcpClientDefault, {
  AcpContractClientV2,
  baseAcpConfigV2,
  baseSepoliaAcpConfigV2,
  FareAmount,
  AcpJobPhases,
} from '@virtuals-protocol/acp-node';

// Handle CJS/ESM interop
const AcpClient = (AcpClientDefault as any).default || AcpClientDefault;

const REQUIRED_ENV = ['BUYER_PRIVATE_KEY', 'BUYER_ENTITY_ID', 'BUYER_WALLET_ADDRESS', 'PROVIDER_WALLET_ADDRESS'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const postUrl = process.argv[2];
if (!postUrl || !/(?:twitter\.com|x\.com)\/\w+\/status\/\d+/.test(postUrl)) {
  console.error('Usage: npx tsx scripts/test-job.ts <x-post-url>');
  process.exit(1);
}

const useTestnet = process.env['ACP_TESTNET'] === 'true';
const config = useTestnet ? baseSepoliaAcpConfigV2 : baseAcpConfigV2;

console.log(`[Test] Network: ${useTestnet ? 'Base Sepolia (testnet)' : 'Base (mainnet)'}`);
console.log(`[Test] Post URL: ${postUrl}`);
console.log(`[Test] Provider: ${process.env['PROVIDER_WALLET_ADDRESS']}`);

const pk = process.env['BUYER_PRIVATE_KEY']!;
const contractClient = await AcpContractClientV2.build(
  (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`,
  Number(process.env['BUYER_ENTITY_ID']),
  process.env['BUYER_WALLET_ADDRESS']! as `0x${string}`,
  config,
);

const acpClient = new AcpClient({ acpContractClient: contractClient });
await acpClient.init();
console.log('[Test] ACP client initialized');

// Initiate job
console.log('[Test] Sending job...');
const subnet = process.argv[3] || 'crypto';
console.log(`[Test] Subnet: ${subnet}`);

const jobId = await acpClient.initiateJob(
  process.env['PROVIDER_WALLET_ADDRESS']! as `0x${string}`,
  { postUrl, subnet },
  new FareAmount(5, baseAcpConfigV2.baseFare),
);
console.log(`[Test] Job created: #${jobId}`);

// Poll for completion
const POLL_MS = 5_000;
const TIMEOUT_MS = 5 * 60_000; // 5 minutes
const start = Date.now();

console.log('[Test] Polling for result...');
while (Date.now() - start < TIMEOUT_MS) {
  const job = await acpClient.getJobById(jobId);
  if (!job) {
    console.log('[Test] Job not found, retrying...');
    await new Promise((r) => setTimeout(r, POLL_MS));
    continue;
  }

  const phase = job.phase;
  console.log(`[Test] Job #${jobId} phase: ${AcpJobPhases[phase] ?? phase}`);

  // Buyer approves payment when agent has accepted (NEGOTIATION)
  if (phase === AcpJobPhases.NEGOTIATION) {
    try {
      await job.payAndAcceptRequirement();
      console.log('[Test] Payment approved, moving to TRANSACTION');
    } catch (err) {
      // May fail if agent hasn't posted terms yet, retry next poll
      console.log(`[Test] payAndAcceptRequirement not ready yet: ${(err as Error).message}`);
    }
  }

  // Buyer evaluates deliverable when in EVALUATION phase
  if (phase === AcpJobPhases.EVALUATION) {
    try {
      await job.evaluate(true, 'Looks good');
      console.log('[Test] Deliverable approved');
    } catch (err) {
      console.log(`[Test] evaluate failed: ${(err as Error).message}`);
    }
  }

  if (phase === AcpJobPhases.COMPLETED) {
    console.log('[Test] Job completed!');
    console.log('[Test] Deliverable:', job.deliverable);
    process.exit(0);
  }

  if (phase === AcpJobPhases.REJECTED) {
    console.error('[Test] Job rejected:', job.rejectionReason);
    process.exit(1);
  }

  if (phase === AcpJobPhases.EXPIRED) {
    console.error('[Test] Job expired');
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, POLL_MS));
}

console.error(`[Test] Timed out after ${TIMEOUT_MS / 1000}s`);
process.exit(1);
