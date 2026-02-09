# Reppo ACP Agent

Standalone Node.js/TypeScript service that registers as **@reppodant** on [Virtuals Protocol ACP v2](https://whitepaper.virtuals.io/acp-product-resources/introducing-acp-v2), accepts jobs from other AI agents, fetches X post content, mints pods on Base, and submits metadata to Reppo's API.

## Features

- 🤖 **ACP v2 Integration** — Accepts jobs from any agent in the Virtuals ecosystem
- 🐦 **X/Twitter Fetching** — Extracts post content, author, and media
- ⛓️ **On-chain Minting** — Mints pods on Base with automatic REPPO token handling
- 💱 **Auto Swap** — Swaps USDC → REPPO via Uniswap V3 when balance is low
- 👤 **Buyer Profiles** — Creates Reppo profiles for buyer agents on-demand
- 🔒 **Production-Ready** — Retry logic, deduplication, file locking, structured logging

## How it works

```
Other AI Agents (Virtuals ecosystem)
       │
       │ ACP job: {postUrl, subnet, agentName?, agentDescription?}
       v
┌──────────────────────────────────────────┐
│   reppo-acp-agent                        │
│   Identity: @reppodant                   │
│                                          │
│  1. Validate job payload                 │
│  2. Check dedup (prevent double-mint)    │
│  3. Accept ACP job                       │
│  4. Fetch X post content via X API       │
│  5. Swap USDC → REPPO if needed          │
│  6. Mint pod on Base (on-chain)          │
│  7. Create buyer profile (if provided)   │
│  8. Submit metadata to Reppo API         │
│  9. Deliver result via ACP               │
└──────────────────────────────────────────┘
       │
       │ {postUrl, subnet, txHash, podId, basescanUrl}
       v
  Buyer agent receives result
```

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | Wallet private key (32-byte hex, with or without 0x) |
| `ACP_ENTITY_ID` | Yes | Entity ID from [Virtuals ACP](https://app.virtuals.io/acp/join) |
| `ACP_WALLET_ADDRESS` | Yes | AA wallet address from Virtuals (0x-prefixed) |
| `REPPO_API_URL` | Yes | Reppo API base URL (`https://reppo.ai/api/v1`) |
| `REPPO_AGENT_NAME` | Yes | Agent name for Reppo registration |
| `REPPO_AGENT_DESCRIPTION` | Yes | Agent description for Reppo registration |
| `TWITTER_BEARER_TOKEN` | Yes | X API bearer token (app-only, read-only) |
| `RPC_URL` | No | Custom Base RPC URL (defaults to public) |
| `POLL_INTERVAL_MS` | No | ACP polling interval in ms (default: 10000) |
| `ACP_TESTNET` | No | Set to `true` for Base Sepolia testnet |
| `HEALTH_PORT` | No | Health check server port (default: 3000) |
| `LOG_LEVEL` | No | Log level: debug, info, warn, error (default: info) |

## Usage

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

On startup the agent will:
1. Load and validate configuration
2. Initialize dedup state from disk
3. Start health check server
4. Register with Reppo API (first run only)
5. Initialize chain clients (Base)
6. Connect to ACP and start polling for jobs

## Health Checks

The agent exposes health endpoints for monitoring:

```bash
# Liveness check (JSON)
curl http://localhost:3000/health

# Readiness check
curl http://localhost:3000/ready
```

Response:
```json
{
  "status": "healthy",
  "started": "2025-02-09T22:00:00.000Z",
  "lastPoll": "2025-02-09T22:05:00.000Z",
  "processedTweets": 42,
  "uptime": 3600
}
```

## Job Payload Schema

Jobs submitted via ACP must include:

```json
{
  "postUrl": "https://x.com/user/status/1234567890",
  "subnet": "crypto",
  "agentName": "MyAgent",
  "agentDescription": "Optional agent bio for new Reppo profiles"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `postUrl` | Yes | X/Twitter post URL |
| `subnet` | Yes | Reppo subnet to publish to |
| `agentName` | No | Create Reppo profile for buyer agent |
| `agentDescription` | No | Profile description (uses agentName if omitted) |

## Testing

```bash
npm test
```

## Project Structure

```
src/
  index.ts              Entry point — init, health server, polling, shutdown
  config.ts             Env var loading & validation
  constants.ts          Contract addresses, ABIs, pool fees
  types.ts              Shared TypeScript types
  acp.ts                ACP v2 client setup & callbacks
  twitter.ts            X API client (fetch tweet by URL)
  reppo.ts              Reppo API (register agent, submit pod metadata)
  chain.ts              Viem clients, swap, mintPod, approve
  lib/
    http.ts             fetchJSON, withRetry, isRetryableError
    logger.ts           Structured logging (pino)
    dedup.ts            Deduplication with file persistence & locking
  handlers/
    publish.ts          Core job handler (validate → fetch → mint → deliver)
  __tests__/            Unit tests (vitest)
```

## State Files

The agent persists state to these files (gitignored):

| File | Purpose |
|------|---------|
| `.reppo-session.json` | Reppodant agent credentials |
| `.reppo-buyer-sessions.json` | Cached buyer agent credentials |
| `.reppo-dedup.json` | Processed tweet IDs (prevents double-mint) |

## Contracts (Base Mainnet)

| Contract | Address |
|----------|---------|
| PodManager | `0xcfF0511089D0Fbe92E1788E4aFFF3E7930b3D47c` |
| REPPO Token | `0xFf8104251E7761163faC3211eF5583FB3F8583d6` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Uniswap SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Uniswap QuoterV2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |

## Error Handling

The agent includes comprehensive error handling:

- **Retry Logic** — All API calls and chain operations retry with exponential backoff
- **Rate Limits** — Twitter API retries with longer delays (5 attempts, 2s base)
- **Deduplication** — Same tweet won't be minted twice (persisted across restarts)
- **Mutex Locks** — Prevents concurrent processing of the same tweet
- **Graceful Shutdown** — SIGINT/SIGTERM handled, waits for in-flight jobs

## Logging

Structured JSON logging via pino. Set `LOG_LEVEL=debug` for verbose output.

```bash
# Pretty print in development
LOG_LEVEL=debug npm run dev
```

## License

MIT
