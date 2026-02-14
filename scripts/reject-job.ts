import 'dotenv/config';
import _AcpModule, { AcpContractClientV2, baseAcpConfigV2 } from '@virtuals-protocol/acp-node';
const AcpClient = (_AcpModule as any).default ?? _AcpModule;

const jobId = Number(process.argv[2]);
if (!jobId) { console.error('Usage: npx tsx scripts/reject-job.ts <jobId>'); process.exit(1); }

const pk = process.env['PRIVATE_KEY']! as `0x${string}`;
const entityId = Number(process.env['ACP_SIGNER_ENTITY_ID'] || '3');
const wallet = process.env['ACP_WALLET_ADDRESS']! as `0x${string}`;

const contractClient = await AcpContractClientV2.build(pk, entityId, wallet, baseAcpConfigV2);
const client = new AcpClient({ acpContractClient: contractClient });
await client.init();

const jobs = await client.getActiveJobs(1, 10);
console.log(`Found ${jobs.length} active jobs`);
const job = jobs.find((j: any) => j.id === jobId);
if (!job) { console.error(`Job ${jobId} not found. IDs: ${jobs.map((j:any) => j.id)}`); process.exit(1); }
console.log(`Found job ${jobId}, phase: ${job.phase}`);
await job.reject('Test complete - cancelling');
console.log(`Job ${jobId} rejected`);
