# Reppo ACP Agent — Standalone Service Plan

## Context

A **new standalone Node.js service** that bridges Virtuals Protocol's ACP (Agent Commerce Protocol) v2 with Reppo. It registers on ACP as a provider under the **@reppodant** identity, monitors X for mentions, and when a user replies to a post tagging @reppodant, the agent grabs the parent post's content, mints a pod on Base, and submits metadata to Reppo's API.

This is a **separate project** from `reppo-agent-publisher`. It interacts with Reppo purely via REST API, fully decoupled.

### Why @reppodant (not the main Reppo account)

The ACP agent allows external agents and users to publish arbitrary content. Associating this with the main **@repaboratory** / Reppo account on X could violate X's Terms of Service, since the platform would see a single account publishing unvetted third-party content at scale. To mitigate this:

- **@reppodant** is a dedicated agent account on X that serves as the public-facing identity for all ACP interactions
- The main Reppo brand stays clean and compliant — no user-generated content flows through it
- @reppodant is clearly positioned as an autonomous agent, not the official Reppo editorial voice

### Entry Points

Users and agents can interact with @reppodant through two paths:

1. **Direct @reppodant mention on X** (primary) — A user replies to any post on X tagging @reppodant. The agent fetches the parent post's content (text, images, metadata), mints a pod, and replies with the result.
2. **Via Butler / ACP** — Other AI agents in the Virtuals ecosystem can request publishing through ACP jobs routed by Butler. The agent extracts the X post URL from the job payload, fetches the content, and processes it the same way.

---

## What the Service Does

```
  X post (original content)
       │
       │  User replies: "@reppodant"
       │
       v
┌──────────────────────┐        Other AI Agents
│  @reppodant mention  │        (Virtuals ecosystem)
│  detected on X       │               │
└──────────┬───────────┘               │ ACP job with X post URL
           │                           │
           v                           v
┌──────────────────────────────────────────┐
│   reppo-acp-agent (this project)         │
│   Identity: @reppodant                   │
│                                          │
│  1. Detect mention / accept ACP job      │
│  2. Fetch parent post content via X API  │
│     (text, images, author, metadata)     │
│  3. Mint pod on Base (on-chain)          │
│  4. POST metadata to Reppo API           │
│  5. Reply on X via @reppodant with links │
│  6. Deliver result via ACP (if ACP job)  │
└──────────────────────────────────────────┘
       │
       │ @reppodant reply: "Pod minted! 🔗 reppo.ai/pod/123 | basescan.org/tx/0x..."
       │ ACP deliverable: {postUrl, txHash, podId, basescanUrl}
       v
  User sees reply on X / Buyer agent gets ACP result
```

## External Interfaces

### Reppo API (`https://reppo.ai/api/v1`)
- `POST /agents/register` → `{agentId, accessToken}` — one-time registration
- `POST /agents/{agentId}/pods` — submit pod metadata after on-chain mint
- Auth: `Authorization: Bearer <accessToken>`

### X / Twitter API (via @reppodant)
- Monitor mentions of @reppodant (filtered stream or polling)
- Fetch parent post content: `GET /2/tweets/:id` with `tweet.fields=text,author_id,attachments,created_at` and `expansions=attachments.media_keys,author_id`
- Reply to users with mint results (Reppo pod URL, basescan link)
- Auth: OAuth 2.0 credentials for the @reppodant account

### On-chain (Base, chainId 8453)
- PodManager (`0xcfF0511089D0Fbe92E1788E4aFFF3E7930b3D47c`): `mintPod(to, emissionSharePercent)`
- REPPO Token (`0xFf8104251E7761163faC3211eF5583FB3F8583d6`): `approve()` for publishing fee
- Requires private key for signing transactions

### ACP v2 (`@virtuals-protocol/acp-node`)
- `AcpContractClientV2.build(privateKey, entityId, walletAddress)` — init
- `AcpClient` with `onNewTask` / `onEvaluate` callbacks — listen for jobs
- `job.respond()`, `job.deliver()` — job lifecycle
- WebSocket + polling for real-time job notifications
- Payments in USDC via on-chain escrow

---

## ACP v2 Key Concepts

### Architecture
ACP is a blockchain-based framework on Base chain enabling autonomous AI agents to discover each other, negotiate services, execute transactions, and settle payments through smart contracts.

### Agent Roles (per transaction)
- **Client/Buyer**: Requests task completion
- **Provider/Seller**: Executes and delivers work
- **Evaluator**: Optional neutral party approving deliverables

### Job Lifecycle (5 phases)
1. **Request** — Buyer initiates job from an offering
2. **Negotiation** — Provider accepts/rejects, terms finalized
3. **Transaction** — Payment locked in on-chain escrow
4. **Evaluation** — Deliverable assessed, client/evaluator approves
5. **Completed** — Funds auto-released to provider

### Memos
Signed on-chain messages that drive job state progression:
- `RequestMemo` — initializes job
- `AgreementMemo` — finalizes terms
- `TransactionMemo` — authorizes payment
- `DeliverableMemo` — submits completed work
- `NotificationMemo` — status updates (no state change)

### Job Offerings
Service catalog entries published by providers:
- Name, description, pricing (USDC)
- Requirements schema (JSON Schema validation)
- SLA and expected deliverables

### SDK API Surface

```typescript
// Initialize
const acpContractClient = await AcpContractClientV2.build(
  privateKey,       // 0x-prefixed
  entityId,         // numeric, from Virtuals registry
  walletAddress,    // AA wallet address
  rpcUrl?,          // optional custom RPC
);

const acpClient = new AcpClient({
  acpContractClient,
  onNewTask: async (job, memoToSign?) => { /* handle incoming jobs */ },
  onEvaluate: async (job) => { /* handle evaluation requests */ },
});
await acpClient.init();

// Discovery
const agents = await acpClient.browseAgents("keyword", {
  topK: 5,
  onlineStatus: "ALL",
  graduationStatus: "ALL",
});

// Job management
const activeJobs = await acpClient.getActiveJobs(page, pageSize);
const completedJobs = await acpClient.getCompletedJobs(page, pageSize);

// Job actions (inside callbacks)
await job.respond(true);                    // accept
await job.respond(false, "reason");         // reject
await job.createRequirement("content");     // request payment
await job.payAndAcceptRequirement();        // buyer pays
await job.deliver({ type: "url", value: "..." }); // submit deliverable
await job.evaluate(true, "reasoning");      // approve deliverable
```

### Registration
Agents register via Virtuals web UI (https://app.virtuals.io/acp/join):
1. Create smart wallet (Account Abstraction)
2. Whitelist developer wallet
3. Get entity ID and AA wallet address
4. Publish job offerings

---

## Project Structure

```
reppo-acp-agent/
  package.json
  tsconfig.json
  .env.example
  src/
    index.ts              # Entry point — init ACP client + mention listener, start service
    config.ts             # Load env vars, validate config
    acp.ts                # ACP client init, job lifecycle handlers
    twitter.ts            # X API client — monitor @reppodant mentions, fetch posts, reply
    reppo.ts              # Reppo API client (register, submit metadata)
    chain.ts              # Viem clients, mintPod, approve REPPO
    handlers/
      mention.ts          # Handle @reppodant mention → fetch parent post → mint → reply
      acpJob.ts           # Handle ACP job → extract X post URL → fetch → mint → deliver
    types.ts              # Shared types
```

## Key Dependencies

- `@virtuals-protocol/acp-node` — ACP v2 SDK
- `viem` — Base chain interaction
- `twitter-api-v2` — X API client for @reppodant (mentions, fetch posts, reply)
- `dotenv` — environment config

---

## Service Flow

### Startup (`src/index.ts`)
1. Load config from env vars
2. Register with Reppo API if no session exists (one-time)
3. Init ACP client with `onNewTask` and `onEvaluate` callbacks
4. Init @reppodant X mention listener (filtered stream or polling)
5. Start polling loop for ACP jobs + mention checks
6. Log readiness

### Mention Handler (`src/handlers/mention.ts`) — Primary Flow
When a user replies to a post on X tagging @reppodant:
1. Detect mention via X API (filtered stream or polling)
2. Resolve the parent post (the post being replied to) — `in_reply_to_tweet_id`
3. Fetch parent post content via X API:
   - Text body
   - Author handle + display name
   - Attached images/media URLs
   - Original post URL (`https://x.com/{author}/status/{id}`)
4. Approve REPPO spend if needed → `reppo.approve(podManager, publishingFee)`
5. Call `podManager.mintPod(address, 50)` → get `txHash`, `podId`
6. POST metadata to Reppo API (`/agents/{agentId}/pods`) with:
   - `title`: derived from post text (first line or truncated)
   - `sourceUrl`: the original X post URL
   - `author`: original post author handle
   - `imageUrl`: first attached image (if any)
7. Reply to the user via @reppodant: "Pod minted! reppo.ai/pod/{podId} | basescan.org/tx/{txHash}"

### ACP Job Handler (`src/handlers/acpJob.ts`)
When an AI agent submits a job via ACP (directly or routed by Butler):
1. Parse job payload — expects `{postUrl}` (an X post URL)
2. Fetch the X post content using the same logic as the mention handler
3. Mint pod + submit metadata (same steps 4–6 above)
4. Call `job.deliver({postUrl, txHash, podId, basescanUrl, reppoUrl})`

### Single Offering (registered under @reppodant identity)

**"Reppodant Publish"** — fetch X post content → mint pod → submit to Reppo
- Input: `{postUrl}` (URL of the X post to publish)
- Output: `{postUrl, txHash, podId, basescanUrl, reppoUrl}`

---

## Configuration (`.env`)

```bash
# Required
PRIVATE_KEY=0x...                    # For on-chain ops (mint, approve) + ACP AA wallet
ACP_ENTITY_ID=12345                  # From Virtuals Service Registry
ACP_WALLET_ADDRESS=0x...             # AA wallet from Virtuals

# Reppo
REPPO_API_URL=https://reppo.ai/api/v1
REPPO_AGENT_NAME=reppodant           # Registered under @reppodant identity
REPPO_AGENT_DESCRIPTION=Reppodant — autonomous publishing agent for Reppo

# X / Twitter (@reppodant)
TWITTER_API_KEY=...                  # @reppodant app credentials
TWITTER_API_SECRET=...
TWITTER_ACCESS_TOKEN=...
TWITTER_ACCESS_SECRET=...
TWITTER_BEARER_TOKEN=...             # For filtered stream / search

# Optional
RPC_URL=                             # Custom Base RPC (default: public)
POLL_INTERVAL_MS=30000               # ACP job polling interval
MENTION_POLL_INTERVAL_MS=15000       # @reppodant mention check interval
```

---

## On-Chain Contract Details

### PodManager Contract
```solidity
// Current fee: 200 REPPO
function publishingFee() view returns (uint256)

// Mint pod NFT. Requires prior ERC20 approve of publishingFee.
// emissionSharePercent: pod owner's share (1-100), default 50
function mintPod(address to, uint8 emissionSharePercent) returns (uint256 podId)
```

### REPPO Token (ERC20)
```solidity
function approve(address spender, uint256 amount) returns (bool)
function balanceOf(address account) view returns (uint256)
function allowance(address owner, address spender) view returns (uint256)
```

### Contract Addresses (Base)
| Contract | Address |
|---|---|
| PodManager | `0xcfF0511089D0Fbe92E1788E4aFFF3E7930b3D47c` |
| REPPO Token | `0xFf8104251E7761163faC3211eF5583FB3F8583d6` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

---

## Implementation Phases

### Phase 1: Project scaffold + config + X client
- `package.json`, `tsconfig.json`, `.env.example`
- `src/config.ts` — load and validate env vars (including @reppodant X creds)
- `src/twitter.ts` — X API client: mention monitoring, fetch post content, reply
- `src/reppo.ts` — register agent (as "reppodant"), submit pod metadata
- `src/chain.ts` — viem clients, mintPod, approve, balance checks

### Phase 2: Mention handler (core flow)
- `src/handlers/mention.ts` — detect mention → fetch parent post → mint → submit to Reppo → reply
- Mention dedup (track processed mention IDs, don't mint the same post twice)
- `src/index.ts` — wire mention listener + chain + Reppo, start service

### Phase 3: ACP integration
- `src/acp.ts` — AcpClient init, session management (entity registered as @reppodant)
- `src/handlers/acpJob.ts` — accept ACP job with X post URL → fetch → mint → deliver
- Single offering: "Reppodant Publish"

### Phase 4: Testing + error handling
- Tests with mocked X API, ACP SDK, and chain interactions
- Retry logic for API calls and transactions
- Rate limiting for X API (respect endpoint limits)
- Graceful shutdown on SIGINT
- Logging

---

## Verification

1. Service starts without errors with valid config
2. Registers with Reppo API on first run (as "reppodant")
3. User replies to an X post tagging @reppodant → agent fetches parent post → mints pod → replies with links
4. Same post mentioned twice → second mention is deduped, not minted again
5. ACP job with X post URL → agent fetches post → mints pod → delivers result via ACP
6. Butler-routed ACP jobs processed identically to direct ACP jobs
7. No interaction touches the main Reppo X account
8. Existing reppo-agent-publisher CLI unaffected

---

## References

- ACP Concepts & Architecture: https://whitepaper.virtuals.io/get-started-with-acp/acp-concepts-terminologies-and-architecture
- ACP v2 Introduction: https://whitepaper.virtuals.io/get-started-with-acp/introducing-acp-v2
- ACP Onboarding Guide: https://whitepaper.virtuals.io/acp-product-resources/acp-onboarding-guide
- ACP Node SDK: https://github.com/Virtual-Protocol/acp-node
- ACP v2 PR (code examples): https://github.com/Virtual-Protocol/acp-node/pull/82/files
- Reppo API: https://reppo.ai/api/v1
- PodManager on Basescan: https://basescan.org/address/0xcfF0511089D0Fbe92E1788E4aFFF3E7930b3D47c
