/**
 * Reject a stuck job by ID.
 * Usage: npx tsx scripts/reject-job.ts <jobId>
 */
import _AcpModule, { AcpContractClientV2, baseAcpConfigV2, baseSepoliaAcpConfigV2 } from '@virtuals-protocol/acp-node';
const AcpClient = (_AcpModule as any).default ?? _AcpModule;

const jobId = Number(process.argv[2]);
if (!jobId) { console.error('Usage: npx tsx scripts/reject-job.ts <jobId>'); process.exit(1); }

const pk = (process.env.PRIVATE_KEY || process.env.BUYER_PRIVATE_KEY)!;
const entityId = Number(process.env.ACP_SIGNER_ENTITY_ID || process.env.BUYER_ENTITY_ID);
const wallet = (process.env.ACP_WALLET_ADDRESS || process.env.BUYER_WALLET_ADDRESS)!;
const useTestnet = process.env.ACP_TESTNET === 'true';
const config = useTestnet ? baseSepoliaAcpConfigV2 : baseAcpConfigV2;

const contractClient = await AcpContractClientV2.build(
  (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`,
  entityId,
  wallet as `0x${string}`,
  config,
);

const acpClient = new AcpClient({ acpContractClient: contractClient, skipSocketConnection: true });

const job = await acpClient.getJobById(jobId);
if (!job) { console.error('Job not found'); process.exit(1); }

console.log(`Job #${jobId} phase: ${job.phase}`);
await job.reject('Cleaning up stuck job');
console.log(`Job #${jobId} rejected`);
process.exit(0);
