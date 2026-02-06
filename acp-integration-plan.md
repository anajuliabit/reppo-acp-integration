# Reppo ACP Agent — Standalone Service Plan

## Context

A **new standalone Node.js service** that bridges Virtuals Protocol's ACP (Agent Commerce Protocol) v2 with Reppo. It registers on ACP as a provider, listens for incoming jobs from other AI agents (e.g., agents curating content from X), and fulfills them by publishing to Moltbook + minting pods on Base + submitting metadata to Reppo's API.

This is a **separate project** from `reppo-agent-publisher`. It interacts with Reppo purely via REST API, fully decoupled.

---

## What the Service Does

```
Other AI Agents (Virtuals ecosystem)
       |
       | ACP job request: "publish this content"
       | (title, body, sourceUrl?, imageURL?)
       v
┌─────────────────────────────────┐
│   reppo-acp-agent (this project)│
│                                 │
│  1. Accept ACP job              │
│  2. POST to Moltbook API       │
│  3. Mint pod on Base (on-chain) │
│  4. POST metadata to Reppo API  │
│  5. Deliver result via ACP      │
└─────────────────────────────────┘
       |
       | ACP deliverable: {moltbookUrl, txHash, podId}
       v
  Buyer agent receives result, USDC escrow released
```

## External Interfaces

### Reppo API (`https://reppo.ai/api/v1`)
- `POST /agents/register` → `{agentId, accessToken}` — one-time registration
- `POST /agents/{agentId}/pods` — submit pod metadata after on-chain mint
- Auth: `Authorization: Bearer <accessToken>`

### Moltbook API (`https://www.moltbook.com/api/v1`)
- `POST /posts` — publish content, returns `{id, url}`
- Auth: `Authorization: Bearer <moltbookKey>`

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
    index.ts              # Entry point — init ACP client, start listening
    config.ts             # Load env vars, validate config
    acp.ts                # ACP client init, job lifecycle handlers
    reppo.ts              # Reppo API client (register, submit metadata)
    moltbook.ts           # Moltbook API client (post content)
    chain.ts              # Viem clients, mintPod, approve REPPO
    handlers/
      publish.ts          # Handle "publish" job: moltbook + mint + metadata
      mint.ts             # Handle "mint" job: mint + metadata
    types.ts              # Shared types
```

## Key Dependencies

- `@virtuals-protocol/acp-node` — ACP v2 SDK
- `viem` — Base chain interaction
- `dotenv` — environment config

---

## Service Flow

### Startup (`src/index.ts`)
1. Load config from env vars
2. Register with Reppo API if no session exists (one-time)
3. Init ACP client with `onNewTask` and `onEvaluate` callbacks
4. Start polling loop for TRANSACTION-phase jobs
5. Log readiness

### Job Handler (`src/handlers/publish.ts`)
When a "Reppo Content Publish" job reaches TRANSACTION phase:
1. Parse requirements from job (`title`, `body`, `sourceUrl?`, `imageURL?`, `submolt?`)
2. POST to Moltbook API → get `{id, url}`
3. Approve REPPO spend if needed → `reppo.approve(podManager, publishingFee)`
4. Call `podManager.mintPod(address, 50)` → get `txHash`, `podId`
5. POST metadata to Reppo API (`/agents/{agentId}/pods`)
6. Call `job.deliver({moltbookUrl, txHash, podId, basescanUrl})`

### Two Offerings

1. **"Reppo Content Publish"** — full flow: Moltbook + mint + metadata
   - Input: `{title, body, submolt?, description?, imageURL?, sourceUrl?}`
   - Output: `{moltbookUrl, txHash, podId, basescanUrl}`

2. **"Reppo Pod Mint"** — mint from existing URL
   - Input: `{title, url, description?, imageURL?, sourceUrl?}`
   - Output: `{txHash, podId, basescanUrl}`

`sourceUrl` is optional — agents can include an X post link or other content attribution URL.

---

## Configuration (`.env`)

```bash
# Required
PRIVATE_KEY=0x...                    # For on-chain ops (mint, approve) + ACP AA wallet
ACP_ENTITY_ID=12345                  # From Virtuals Service Registry
ACP_WALLET_ADDRESS=0x...             # AA wallet from Virtuals

# Reppo
REPPO_API_URL=https://reppo.ai/api/v1
REPPO_AGENT_NAME=my-acp-agent       # For one-time registration
REPPO_AGENT_DESCRIPTION=Publishes content via ACP

# Moltbook
MOLTBOOK_API_KEY=...
MOLTBOOK_API_URL=https://www.moltbook.com/api/v1

# Optional
RPC_URL=                             # Custom Base RPC (default: public)
POLL_INTERVAL_MS=30000               # Job polling interval
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

### Phase 1: Project scaffold + config + Reppo/Moltbook clients
- `package.json`, `tsconfig.json`, `.env.example`
- `src/config.ts` — load and validate env vars
- `src/reppo.ts` — register agent, submit metadata (HTTP calls)
- `src/moltbook.ts` — post content (HTTP call)
- `src/chain.ts` — viem clients, mintPod, approve, balance checks

### Phase 2: ACP integration + job handlers
- `src/acp.ts` — AcpClient init, session management
- `src/handlers/publish.ts` — full publish job handler
- `src/handlers/mint.ts` — mint-only job handler
- `src/index.ts` — wire everything together, start service

### Phase 3: Testing + error handling
- Tests with mocked ACP SDK, HTTP calls, and chain interactions
- Retry logic for API calls and transactions
- Graceful shutdown on SIGINT
- Logging

---

## Verification

1. Service starts without errors with valid config
2. Registers with Reppo API on first run
3. Connects to ACP and listens for jobs
4. Mock ACP job triggers publish handler → Moltbook post + pod mint + metadata submission
5. Deliverable sent back via ACP with correct fields
6. Existing reppo-agent-publisher CLI unaffected

---

## References

- ACP Concepts & Architecture: https://whitepaper.virtuals.io/get-started-with-acp/acp-concepts-terminologies-and-architecture
- ACP v2 Introduction: https://whitepaper.virtuals.io/get-started-with-acp/introducing-acp-v2
- ACP Onboarding Guide: https://whitepaper.virtuals.io/acp-product-resources/acp-onboarding-guide
- ACP Node SDK: https://github.com/Virtual-Protocol/acp-node
- ACP v2 PR (code examples): https://github.com/Virtual-Protocol/acp-node/pull/82/files
- Reppo API: https://reppo.ai/api/v1
- PodManager on Basescan: https://basescan.org/address/0xcfF0511089D0Fbe92E1788E4aFFF3E7930b3D47c
