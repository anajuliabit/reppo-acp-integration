import AcpClient, { AcpContractClientV2, baseAcpConfigV2, baseSepoliaAcpConfigV2 } from '@virtuals-protocol/acp-node';
import type { Config } from './config.js';
import { handlePublishJob } from './handlers/publish.js';
import { createLogger } from './lib/logger.js';
import type { Clients, AgentSession, AcpJob } from './types.js';

const log = createLogger('acp');

export interface AcpContext {
  client: AcpClient;
}

export async function initAcp(
  config: Config,
  clients: Clients,
  session: AgentSession,
): Promise<AcpContext> {
  const pk = config.PRIVATE_KEY.startsWith('0x') ? config.PRIVATE_KEY : `0x${config.PRIVATE_KEY}`;

  const acpConfig = config.ACP_TESTNET ? baseSepoliaAcpConfigV2 : baseAcpConfigV2;

  log.info({ 
    entityId: config.ACP_ENTITY_ID, 
    testnet: config.ACP_TESTNET,
  }, 'Building ACP contract client...');

  const contractClient = await AcpContractClientV2.build(
    pk as `0x${string}`,
    config.ACP_ENTITY_ID,
    config.ACP_WALLET_ADDRESS as `0x${string}`,
    acpConfig,
  );

  const acpClient = new AcpClient({
    acpContractClient: contractClient,
    onNewTask: async (job: unknown) => {
      const typedJob = job as AcpJob;
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
      const typedJob = job as AcpJob;
      const jobId = typedJob.id ?? 'unknown';
      log.info({ jobId }, 'Evaluate request received');
      
      try {
        await typedJob.evaluate(true, 'Auto-approved by reppodant');
        log.info({ jobId }, 'Job auto-approved');
      } catch (err) {
        log.error({ jobId, error: (err as Error).message }, 'Evaluation failed');
      }
    },
  });

  await acpClient.init();
  log.info('ACP client initialized');

  return { client: acpClient };
}
