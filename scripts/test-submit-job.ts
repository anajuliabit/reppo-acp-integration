/**
 * Test script: Submit a job to Reppodant via ACP
 * 
 * Usage:
 *   BUYER_PRIVATE_KEY=0x... BUYER_ENTITY_ID=... BUYER_WALLET=0x... \
 *   npx tsx scripts/test-submit-job.ts https://x.com/user/status/123456
 */

import AcpClient, { 
  AcpContractClientV2, 
  baseAcpConfigV2,
} from '@virtuals-protocol/acp-node';

// Reppodant's entity ID on mainnet (update if different)
const REPPODANT_ENTITY_ID = process.env.REPPODANT_ENTITY_ID || '';

// Buyer credentials (from Virtuals registration)
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const BUYER_ENTITY_ID = parseInt(process.env.BUYER_ENTITY_ID || '0');
const BUYER_WALLET = process.env.BUYER_WALLET as `0x${string}`;

async function main() {
  const postUrl = process.argv[2];
  const subnet = process.argv[3] || 'test-subnet';

  if (!postUrl) {
    console.error('Usage: npx tsx scripts/test-submit-job.ts <post-url> [subnet]');
    process.exit(1);
  }

  if (!BUYER_PRIVATE_KEY || !BUYER_ENTITY_ID || !BUYER_WALLET) {
    console.error('Missing env vars: BUYER_PRIVATE_KEY, BUYER_ENTITY_ID, BUYER_WALLET');
    process.exit(1);
  }

  if (!REPPODANT_ENTITY_ID) {
    console.error('Missing REPPODANT_ENTITY_ID - set it to Reppodant\'s ACP entity ID');
    process.exit(1);
  }

  console.log('Building ACP client...');
  console.log(`  Buyer Entity: ${BUYER_ENTITY_ID}`);
  console.log(`  Buyer Wallet: ${BUYER_WALLET}`);
  console.log(`  Target: Reppodant (${REPPODANT_ENTITY_ID})`);

  const contractClient = await AcpContractClientV2.build(
    BUYER_PRIVATE_KEY,
    BUYER_ENTITY_ID,
    BUYER_WALLET,
    baseAcpConfigV2,
  );

  const acpClient = new AcpClient({
    acpContractClient: contractClient,
    onNewTask: async (job) => {
      console.log('Received task (unexpected for buyer):', job);
    },
    onEvaluate: async (job) => {
      console.log('Evaluation request:', job);
      // Auto-approve for testing
      await job.evaluate(true, 'Test approved');
    },
  });

  await acpClient.init();
  console.log('ACP client initialized');

  // Browse for Reppodant agent
  console.log('\nSearching for Reppodant...');
  const agents = await acpClient.browseAgents({
    query: 'reppodant pod minting',
    limit: 5,
  });

  console.log(`Found ${agents.length} agents:`);
  for (const agent of agents) {
    console.log(`  - ${agent.name} (ID: ${agent.id})`);
    if (agent.offerings?.length) {
      for (const offering of agent.offerings) {
        console.log(`    Offering: ${offering.name} - $${offering.price}`);
      }
    }
  }

  // Find Reppodant or use first agent with matching offering
  const reppodant = agents.find(a => 
    a.name?.toLowerCase().includes('reppodant') ||
    a.id?.toString() === REPPODANT_ENTITY_ID
  );

  if (!reppodant) {
    console.error('\nReppodant not found. Available agents:', agents.map(a => a.name));
    process.exit(1);
  }

  const offering = reppodant.offerings?.[0];
  if (!offering) {
    console.error('No offerings found for Reppodant');
    process.exit(1);
  }

  console.log(`\nSubmitting job to ${reppodant.name}...`);
  console.log(`  Offering: ${offering.name}`);
  console.log(`  Post URL: ${postUrl}`);
  console.log(`  Subnet: ${subnet}`);

  // Create job request
  const jobPayload = {
    postUrl,
    subnet,
    agentName: 'TestBuyer',
    agentDescription: 'Test buyer agent for Reppodant integration',
  };

  const job = await acpClient.createJob({
    offeringId: offering.id,
    content: JSON.stringify(jobPayload),
  });

  console.log(`\nJob created: ${job.id}`);
  console.log('Waiting for acceptance...');

  // Poll for job status
  let attempts = 0;
  const maxAttempts = 30;
  
  while (attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 5000));
    attempts++;

    const status = await acpClient.getJob(job.id);
    console.log(`[${attempts}/${maxAttempts}] Status: ${status.state}`);

    if (status.state === 'COMPLETED') {
      console.log('\n✅ Job completed!');
      console.log('Deliverable:', JSON.stringify(status.deliverable, null, 2));
      break;
    } else if (status.state === 'REJECTED' || status.state === 'FAILED') {
      console.log('\n❌ Job failed:', status.reason || 'Unknown reason');
      break;
    }
  }

  if (attempts >= maxAttempts) {
    console.log('\n⏱️ Timeout waiting for job completion');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
