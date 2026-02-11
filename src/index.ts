import http from 'http';
import { loadConfig, fetchAcpAgentInfoById } from './config.js';
import { registerAgent, initReppoFiles } from './reppo.js';
import { createClients } from './chain.js';
import { initTwitterClient } from './twitter.js';
import { initAcp } from './acp.js';
import { initDedup, getProcessedCount } from './lib/dedup.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('main');

// Track service state for health checks
const serviceState = {
  started: new Date().toISOString(),
  healthy: false,
  lastPoll: null as string | null,
  activeJobs: 0,
  processedTotal: 0,
};

function createHealthServer(port: number) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const status = serviceState.healthy ? 200 : 503;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: serviceState.healthy ? 'healthy' : 'starting',
        started: serviceState.started,
        lastPoll: serviceState.lastPoll,
        processedTweets: getProcessedCount(),
        uptime: process.uptime(),
      }));
    } else if (req.url === '/ready') {
      const status = serviceState.healthy ? 200 : 503;
      res.writeHead(status);
      res.end(serviceState.healthy ? 'ready' : 'not ready');
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    log.info({ port }, 'Health server listening');
  });

  return server;
}

async function main() {
  // Register global error handlers first, before any async work
  process.on('uncaughtException', (err) => {
    log.fatal({ error: err.message, stack: err.stack }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.fatal({ reason }, 'Unhandled rejection');
    process.exit(1);
  });

  log.info('Starting Reppo ACP Agent...');

  // Load and validate config
  const config = loadConfig();
  log.info({
    entityId: config.ACP_ENTITY_ID,
    walletAddress: config.ACP_WALLET_ADDRESS,
    pollInterval: config.POLL_INTERVAL_MS,
    testnet: config.ACP_TESTNET,
  }, 'Config loaded');

  // Fetch agent info from Virtuals ACP (by entity ID with fallback)
  log.info('Fetching agent info from Virtuals ACP...');
  const acpAgent = await fetchAcpAgentInfoById(config.ACP_ENTITY_ID, config.ACP_TESTNET, config.ACP_WALLET_ADDRESS);
  log.info({
    name: acpAgent.name,
    description: acpAgent.description?.slice(0, 50) + '...',
  }, 'ACP agent info loaded');

  // Initialize file paths and dedup state
  initReppoFiles(config.DATA_DIR);
  initDedup(config.DATA_DIR);

  // Start health server
  const healthServer = createHealthServer(config.HEALTH_PORT);

  // Register with Reppo API (using name/description from ACP)
  const session = await registerAgent(config, acpAgent.name, acpAgent.description);
  log.info({ agentId: session.agentId }, 'Reppo session ready');

  // Init chain clients
  const clients = createClients(config.PRIVATE_KEY, config.RPC_URL);
  log.info({ wallet: clients.account.address }, 'Chain clients ready');

  initTwitterClient({
    appKey: config.TWITTER_API_KEY,
    appSecret: config.TWITTER_API_SECRET,
    accessToken: config.TWITTER_ACCESS_TOKEN,
    accessSecret: config.TWITTER_ACCESS_TOKEN_SECRET,
  });
  log.info('Twitter client ready');

  // Init ACP client
  const acp = await initAcp(config, clients, session);
  log.info('ACP client ready, listening for jobs...');

  // Mark as healthy
  serviceState.healthy = true;

  // Polling loop
  let running = true;
  const poll = async () => {
    while (running) {
      try {
        const jobs = await acp.client.getActiveJobs(1, 10);
        serviceState.lastPoll = new Date().toISOString();
        
        if (jobs && Array.isArray(jobs) && jobs.length > 0) {
          log.info({ count: jobs.length }, 'Active jobs');
          serviceState.activeJobs = jobs.length;
        }
      } catch (err) {
        log.error({ error: err instanceof Error ? err.message : err }, 'Poll error');
      }
      await new Promise((r) => setTimeout(r, config.POLL_INTERVAL_MS));
    }
  };

  const pollPromise = poll();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down...');
    serviceState.healthy = false;
    running = false;
    
    // Close health server
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    
    // Wait for poll loop to finish
    await pollPromise;
    
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.fatal({ error: err.message, stack: err.stack }, 'Fatal error');
  process.exit(1);
});
