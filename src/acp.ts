import AcpClient, { AcpContractClientV2, baseAcpConfigV2, baseSepoliaAcpConfigV2, type AcpJob } from '@virtuals-protocol/acp-node';
import type { Config } from './config.js';
import { handlePublishJob } from './handlers/publish.js';
import type { Clients, AgentSession } from './types.js';

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

  const contractClient = await AcpContractClientV2.build(
    pk as `0x${string}`,
    config.ACP_ENTITY_ID,
    config.ACP_WALLET_ADDRESS as `0x${string}`,
    acpConfig,
  );

  const acpClient = new AcpClient({
    acpContractClient: contractClient,
    onNewTask: async (job: AcpJob) => {
      console.log(`[ACP] New task received: job ${job.id ?? 'unknown'}`);
      try {
        await handlePublishJob(job, clients, session, config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ACP] Job failed: ${message}`);
        try {
          await job.reject(`Job failed: ${message}`);
        } catch (rejectErr) {
          console.error(`[ACP] Failed to reject job:`, rejectErr);
        }
      }
    },
    onEvaluate: async (job: AcpJob) => {
      console.log(`[ACP] Evaluate request for job ${job.id ?? 'unknown'}`);
      try {
        await job.evaluate(true, 'Auto-approved by reppodant');
      } catch (err) {
        console.error(`[ACP] Evaluation failed:`, err);
      }
    },
  });

  await acpClient.init();
  console.log('[ACP] Client initialized');

  return { client: acpClient };
}
