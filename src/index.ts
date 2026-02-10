import http from 'http';
import { loadConfig } from './config.js';
import { registerAgent } from './reppo.js';
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
  log.info('Starting Reppo ACP Agent...');

  // Load and validate config
  const config = loadConfig();
  log.info({
    agent: config.REPPO_AGENT_NAME,
    entityId: config.ACP_ENTITY_ID,
    pollInterval: config.POLL_INTERVAL_MS,
    testnet: config.ACP_TESTNET,
  }, 'Config loaded');

  // Initialize dedup state
  initDedup();

  // Start health server
  const healthServer = createHealthServer(config.HEALTH_PORT);

  /*
  // Register with Reppo API
  const session = await registerAgent(config);
  log.info({ agentId: session.agentId }, 'Reppo session ready');

  // Init chain clients
  const clients = createClients(config.PRIVATE_KEY, config.RPC_URL);
  log.info({ wallet: clients.account.address }, 'Chain clients ready');

  // Init Twitter client
  initTwitterClient(config.TWITTER_BEARER_TOKEN);
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
  
  // Handle uncaught errors
  process.on('uncaughtException', (err) => {
    log.fatal({ error: err.message, stack: err.stack }, 'Uncaught exception');
    process.exit(1);
  });
  
  process.on('unhandledRejection', (reason) => {
    log.fatal({ reason }, 'Unhandled rejection');
    process.exit(1);
  });

  */
}

main().catch((err) => {
  log.fatal({ error: err.message, stack: err.stack }, 'Fatal error');
  process.exit(1);
});
