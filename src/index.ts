import { loadConfig } from './config.js';
import { registerAgent } from './reppo.js';
import { createClients } from './chain.js';
import { initTwitterClient } from './twitter.js';
import { initAcp } from './acp.js';

async function main() {
  console.log('[Reppo ACP Agent] Starting...');

  // Load config
  const config = loadConfig();
  console.log(`[Config] Agent: ${config.REPPO_AGENT_NAME}`);
  console.log(`[Config] ACP Entity ID: ${config.ACP_ENTITY_ID}`);
  console.log(`[Config] Poll interval: ${config.POLL_INTERVAL_MS}ms`);

  // Register with Reppo API
  const session = await registerAgent(config);
  console.log(`[Reppo] Agent ID: ${session.agentId}`);

  // Init chain clients
  const clients = createClients(config.PRIVATE_KEY, config.RPC_URL);
  console.log(`[Chain] Wallet: ${clients.account.address}`);

  // Init Twitter client
  initTwitterClient(config.TWITTER_BEARER_TOKEN);
  console.log('[Twitter] Client initialized');

  // Init ACP client
  const acp = await initAcp(config, clients, session);
  console.log('[ACP] Listening for jobs...');

  // Polling loop
  let running = true;
  const poll = async () => {
    while (running) {
      try {
        const jobs = await acp.client.getActiveJobs(1, 10);
        if (jobs && Array.isArray(jobs) && jobs.length > 0) {
          console.log(`[ACP] ${jobs.length} active job(s)`);
        }
      } catch (err) {
        console.error('[ACP] Poll error:', err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, config.POLL_INTERVAL_MS));
    }
  };

  const pollPromise = poll();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[Reppo ACP Agent] Shutting down...');
    running = false;
    await pollPromise;
    console.log('[Reppo ACP Agent] Stopped');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
