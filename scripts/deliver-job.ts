/**
 * Manually deliver result for active jobs.
 * Usage: npx tsx scripts/deliver-job.ts
 */
import 'dotenv/config';
import _AcpModule, {
  AcpContractClientV2,
  baseAcpConfigV2,
} from '@virtuals-protocol/acp-node';

const AcpClient = (_AcpModule as any).default ?? _AcpModule;

const ENTITY_ID = Number(process.env.ACP_ENTITY_ID!);
const WALLET = process.env.ACP_WALLET_ADDRESS! as `0x${string}`;
const PRIVATE_KEY = process.env.PRIVATE_KEY! as `0x${string}`;
const SIGNER_ENTITY_ID = Number(process.env.ACP_SIGNER_ENTITY_ID || '3');

async function main() {
  const contractClient = await AcpContractClientV2.build(
    PRIVATE_KEY,
    SIGNER_ENTITY_ID,
    WALLET,
    baseAcpConfigV2,
  );
  
  const client = new AcpClient({
    acpContractClient: contractClient,
    onNewTask: async () => {},
  });
  console.log('ACP client initialized');

  const jobs = await client.getActiveJobs(1, 10);
  console.log(`Found ${jobs?.length ?? 0} active jobs`);

  if (!jobs || jobs.length === 0) {
    console.log('No active jobs');
    process.exit(0);
  }

  for (const job of jobs) {
    console.log(`Job #${job.id} phase=${job.phase}`);
    
    if (job.phase === 2) {
      const deliverable = {
        postUrl: 'https://x.com/memoclaw_ai/status/2021535797548081523',
        subnet: 'AIapps',
        txHash: '0xf2251d01c8483576e718f0ceb89c7badecb66bf842d207eaee13e56f160e8219',
        podId: '350',
        basescanUrl: 'https://basescan.org/tx/0xf2251d01c8483576e718f0ceb89c7badecb66bf842d207eaee13e56f160e8219',
      };

      try {
        await job.deliver(deliverable);
        console.log(`✅ Job #${job.id} delivered!`);
      } catch (err: any) {
        console.error(`❌ Job #${job.id} deliver failed: ${err.message}`);
      }
    } else {
      console.log(`⏭️ Job #${job.id} phase=${job.phase}, skipping`);
    }
  }

  console.log('Done');
  process.exit(0);
}

main().catch(console.error);
