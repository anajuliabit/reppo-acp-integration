import _AcpModule, { AcpContractClientV2, baseAcpConfigV2 } from '@virtuals-protocol/acp-node';
const AcpClient = (_AcpModule as any).default ?? _AcpModule;

const jobId = Number(process.argv[2]);
if (!jobId) { console.error('Usage: npx tsx scripts/check-job.ts <jobId>'); process.exit(1); }

const pk = process.env.PRIVATE_KEY!;
const contractClient = await AcpContractClientV2.build(
  (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`,
  Number(process.env.ACP_SIGNER_ENTITY_ID),
  process.env.ACP_WALLET_ADDRESS! as `0x${string}`,
  baseAcpConfigV2,
);
const client = new AcpClient({ acpContractClient: contractClient, skipSocketConnection: true });
const job = await client.getJobById(jobId);
console.log('Phase:', job.phase);
console.log('Price:', job.price);
console.log('Memos count:', job.memos?.length);
for (const m of (job.memos || [])) {
  console.log(`  Memo: type=${m.type} nextPhase=${m.nextPhase} state=${m.state} content=${JSON.stringify(m.content || m.message || '').slice(0,80)}`);
}
process.exit(0);
