import _AcpModule, { AcpContractClientV2, baseAcpConfigV2, baseSepoliaAcpConfigV2 } from '@virtuals-protocol/acp-node';
// Handle ESM default export
const AcpClient = (_AcpModule as any).default ?? _AcpModule;
import type { Config } from './config.js';
import { handlePublishJob } from './handlers/publish.js';
import { verifyMintTx } from './lib/verify.js';
import { createLogger } from './lib/logger.js';
import type { Clients, AgentSession, AcpJob } from './types.js';

const log = createLogger('acp');

function validateAcpJob(job: unknown): AcpJob {
  if (!job || typeof job !== 'object') {
    throw new Error('Invalid ACP job: expected an object');
  }
  const j = job as Record<string, unknown>;
  if (typeof j.accept !== 'function' || typeof j.reject !== 'function' || typeof j.deliver !== 'function') {
    throw new Error('Invalid ACP job: missing required lifecycle methods (accept/reject/deliver)');
  }
  return job as AcpJob;
}

export interface AcpContext {
  client: InstanceType<typeof AcpClient>;
  contractClient: InstanceType<typeof AcpContractClientV2>;
}

export async function initAcp(
  config: Config,
  clients: Clients,
  session: AgentSession,
): Promise<AcpContext> {
  // PRIVATE_KEY is already 0x-normalized by loadConfig()
  const pk = config.PRIVATE_KEY as `0x${string}`;

  const acpConfig = config.ACP_TESTNET ? baseSepoliaAcpConfigV2 : baseAcpConfigV2;

  log.info({ 
    entityId: config.ACP_ENTITY_ID,
    signerEntityId: config.ACP_SIGNER_ENTITY_ID,
    testnet: config.ACP_TESTNET,
  }, 'Building ACP contract client...');

  // Use signer entity ID for the SDK (validation module uses different IDs than ACP registry)
  const contractClient = await AcpContractClientV2.build(
    pk,
    config.ACP_SIGNER_ENTITY_ID,
    config.ACP_WALLET_ADDRESS as `0x${string}`,
    acpConfig,
  );

  const acpClient = new AcpClient({
    acpContractClient: contractClient,
    onNewTask: async (job: unknown) => {
      const typedJob = validateAcpJob(job);
      const jobId = typedJob.id ?? 'unknown';
      log.info({ jobId }, 'New task received');
      
      try {
        await handlePublishJob(typedJob, clients, session, config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ jobId, error: message }, 'Job failed');
        
        try {
          await typedJob.reject(`Job failed: ${message}`);
        } catch (rejectErr) {
          log.error({ jobId, error: (rejectErr as Error).message }, 'Failed to reject job');
        }
      }
    },
    onEvaluate: async (job: unknown) => {
      const typedJob = validateAcpJob(job);
      const jobId = typedJob.id ?? 'unknown';
      log.info({ jobId }, 'Evaluate request received');
      
      try {
        // Extract deliverable from memos to verify the mint tx
        const deliverableMemo = (typedJob.memos || [])
          .map((m: any) => {
            try { return typeof m.content === 'string' ? JSON.parse(m.content) : m.content; } 
            catch { return null; }
          })
          .find((d: any) => d?.txHash);

        if (!deliverableMemo?.txHash) {
          log.warn({ jobId }, 'No txHash in deliverable, rejecting evaluation');
          await typedJob.evaluate(false, 'No transaction hash found in deliverable');
          return;
        }

        // Verify the mint tx on-chain
        const verified = await verifyMintTx(deliverableMemo.txHash, config.ACP_TESTNET);
        if (verified) {
          await typedJob.evaluate(true, `Pod mint verified on-chain: ${deliverableMemo.txHash}`);
          log.info({ jobId, txHash: deliverableMemo.txHash }, 'Evaluation approved — mint tx verified');
        } else {
          await typedJob.evaluate(false, `Mint tx failed or not found: ${deliverableMemo.txHash}`);
          log.warn({ jobId, txHash: deliverableMemo.txHash }, 'Evaluation rejected — mint tx not verified');
        }
      } catch (err) {
        log.error({ jobId, error: (err as Error).message }, 'Evaluation failed');
        try {
          await typedJob.evaluate(false, `Evaluation error: ${(err as Error).message}`);
        } catch {}
      }
    },
  });

  await acpClient.init();
  log.info('ACP client initialized');

  return { client: acpClient, contractClient };
}
