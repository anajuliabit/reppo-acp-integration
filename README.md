# Reppo ACP Agent

Standalone Node.js/TypeScript service that registers as **@reppodant** on [Virtuals Protocol ACP v2](https://whitepaper.virtuals.io/acp-product-resources/introducing-acp-v2), accepts jobs from other AI agents, fetches X post content, mints pods on Base, and submits metadata to Reppo's API.

## How it works

```
Other AI Agents (Virtuals ecosystem)
       │
       │ ACP job: {postUrl: "https://x.com/.../status/..."}
       v
┌──────────────────────────────────────────┐
│   reppo-acp-agent                        │
│   Identity: @reppodant                   │
│                                          │
│  1. Accept ACP job                       │
│  2. Fetch X post content via X API       │
│  3. Mint pod on Base (on-chain)          │
│  4. Submit metadata to Reppo API         │
│  5. Deliver result via ACP               │
└──────────────────────────────────────────┘
       │
       │ {postUrl, txHash, podId, basescanUrl}
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
| `PRIVATE_KEY` | Yes | Wallet private key (for on-chain ops + ACP) |
| `ACP_ENTITY_ID` | Yes | Entity ID from [Virtuals ACP](https://app.virtuals.io/acp/join) |
| `ACP_WALLET_ADDRESS` | Yes | AA wallet address from Virtuals |
| `REPPO_API_URL` | Yes | Reppo API base URL (`https://reppo.ai/api/v1`) |
| `REPPO_AGENT_NAME` | Yes | Agent name for Reppo registration |
| `REPPO_AGENT_DESCRIPTION` | Yes | Agent description for Reppo registration |
| `TWITTER_BEARER_TOKEN` | Yes | X API bearer token (app-only, read-only) |
| `RPC_URL` | No | Custom Base RPC URL (defaults to public) |
| `POLL_INTERVAL_MS` | No | ACP polling interval in ms (default: 10000) |

## Usage

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

On startup the agent will:
1. Register with Reppo API (first run only, session persisted to `.reppo-session.json`)
2. Initialize chain clients (Base)
3. Connect to ACP and start polling for jobs

## Testing

```bash
npm test
```

To trigger a test job, use another ACP agent to initiate a job targeting your `ACP_WALLET_ADDRESS` with payload:

```json
{"postUrl": "https://x.com/user/status/1234567890"}
```

## Project structure

```
src/
  index.ts              Entry point — init, polling, graceful shutdown
  config.ts             Env var loading & validation
  constants.ts          Contract addresses, ABIs
  types.ts              Shared TypeScript types
  acp.ts                ACP v2 client setup & callbacks
  twitter.ts            X API client (fetch tweet by URL)
  reppo.ts              Reppo API (register agent, submit pod metadata)
  chain.ts              Viem clients, mintPod, approve REPPO
  lib/
    http.ts             fetchJSON, withRetry
  handlers/
    publish.ts          Core job handler (fetch → mint → submit → deliver)
  __tests__/            Unit tests (vitest)
```

## Contracts (Base)

| Contract | Address |
|----------|---------|
| PodManager | `0xcfF0511089D0Fbe92E1788E4aFFF3E7930b3D47c` |
| REPPO Token | `0xFf8104251E7761163faC3211eF5583FB3F8583d6` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
