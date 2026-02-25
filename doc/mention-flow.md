# X Mention → Conversational Agent → Pod Mint

## Context

Reppodant currently only processes jobs via Virtuals ACP (agent-to-agent). Human users on X can't interact with it directly. This feature adds a **separate server** that runs alongside the ACP agent: it listens for @reppodant mentions on X, responds conversationally (Claude-powered, degen personality), collects USDC payment via a unique deposit address, mints a pod, and replies with the result. The existing ACP agent is completely untouched — both run as independent processes.

## Architecture Overview

Two independent processes sharing the same codebase and on-disk state:

```
Process 1: ACP Agent (src/index.ts)        ← existing, UNCHANGED
  └── ACP job poll loop (~10s)

Process 2: Mention Server (src/mention-server.ts)   ← NEW
  ├── X mention poll loop (~45s)
  └── Payment monitor loop (~15s)
```

**Why separate processes?**
- **Fault isolation** — mention server crash doesn't affect ACP job processing
- **Independent deploys** — update/restart mention server without touching ACP agent
- **Simpler code** — no feature flags, no shared shutdown orchestration in `index.ts`
- **Cleaner ops** — separate logs, separate resource profiles, independent scaling

Both processes share:
- Shared libs (`chain.ts`, `reppo.ts`, `types.ts`, `constants.ts`, `config.ts`)
- File-based dedup (`src/lib/dedup.ts`) — already works across processes via filesystem
- Twitter client setup (`src/twitter.ts`)
- On-chain interactions (`mintPod()`, `submitPodMetadata()`, `getSubnets()`)

Flow: mention detected → Claude classifies intent (Haiku) → if mint request: derive HD deposit address → reply with payment instructions → monitor for USDC Transfer events → mint pod (reuse existing `mintPod()` + `submitPodMetadata()`) → reply with result → sweep deposit.

## New Dependencies

```
@anthropic-ai/sdk    — Claude API (Haiku for classification, Sonnet for replies)
```

No other new deps. viem already has `mnemonicToAccount` for HD derivation. `twitter-api-v2` already supports `.v2.reply()` and `.v2.userMentionTimeline()`.

## File Plan

### New Files

| File | Purpose |
|------|---------|
| `src/mention-server.ts` | Entry point for the mention server — boots Twitter client, starts mention + payment loops, handles graceful shutdown |
| `src/mentions/listener.ts` | Mention polling loop, since_id tracking, rate limiting, dispatches to intent classifier |
| `src/mentions/intent.ts` | Claude Haiku intent classification + Sonnet reply generation |
| `src/mentions/prompts.ts` | System prompt (degen personality), classification template, reply template |
| `src/mentions/payment.ts` | HD wallet derivation (`mnemonicToAccount`), Transfer event scanning, deposit sweep |
| `src/mentions/pipeline.ts` | Orchestrator: `startMintRequest()`, `paymentMonitorLoop()`, `executeMint()` |
| `src/lib/mention-state.ts` | WAL for mention requests (mirrors `pending-jobs.ts` patterns — file lock, in-memory cache) |

### Modified Files

| File | Changes |
|------|---------|
| `src/types.ts` | Add `MentionIntent`, `ClassifiedMention`, `MentionRequest`, `MentionRequestStatus`, `MentionListenerState` |
| `src/constants.ts` | Add `USDC_DECIMALS = 6`, add `transfer` + `Transfer` event to `ERC20_ABI` |
| `src/config.ts` | Add env vars: `ANTHROPIC_API_KEY`, `HD_WALLET_SEED`, `MENTION_POLL_INTERVAL_MS`, `PAYMENT_POLL_INTERVAL_MS`, `PAYMENT_TIMEOUT_MS`, `MINT_PRICE_USDC`, `DEFAULT_SUBNET_ID` |
| `src/twitter.ts` | Add `fetchMentions(sinceId?)` and `replyToTweet(inReplyToId, text)` |

### Unchanged Files

`src/index.ts`, `src/handlers/publish.ts`, `src/chain.ts`, `src/reppo.ts`, `src/acp.ts`, `src/lib/dedup.ts`, `src/lib/pending-jobs.ts`, `src/lib/pods.ts` — reused as-is by the mention pipeline.

## Key Design Decisions

### Separate Server, Shared Libs

The mention server (`src/mention-server.ts`) is a standalone entry point that imports from the same shared modules as `src/index.ts`. No code in the ACP agent is modified. Cross-process coordination happens through:
- **File-based dedup** (`hasProcessed(tweetId)`) — prevents double-minting if a tweet is submitted via both ACP and mention
- **On-chain state** — both processes read the same contract state

### Intent Classification (Claude Haiku)

Each mention is classified into one of: `mint_request`, `question_subnets`, `question_pricing`, `status_check`, `irrelevant`. Haiku returns structured JSON with intent, extracted tweet URL, subnet hint, and confidence score. Low-confidence (<0.5) mentions are skipped. Irrelevant mentions with high confidence are silently ignored.

### Payment Flow (Unique HD Address Per Request)

```
User mentions @reppodant with tweet URL
  → Derive address at index N via mnemonicToAccount(HD_WALLET_SEED, { addressIndex: N })
  → Record watchFromBlock = current block number in request state
  → Reply: "send 5 USDC to 0x... on Base"
  → Payment monitor scans Transfer events to depositAddress from watchFromBlock
  → When matching Transfer found: record txHash as proof of payment
  → Sender address (from Transfer event) = buyer wallet (used for pod tracking / emissions)
  → Mint → reply with result → sweep USDC to main wallet
```

`HD_WALLET_SEED` is a BIP-39 mnemonic stored as env var (separate from `PRIVATE_KEY` for security). Derivation index is monotonically increasing, persisted in mention state file.

### Payment Detection: Transfer Events, Not balanceOf

Payment detection uses **USDC Transfer event logs**, not `balanceOf`. This is critical for idempotency:

- **`balanceOf` is a snapshot** — it can't distinguish a fresh payment from an old unswept balance. On restart, a deposit address with leftover USDC would look like a new payment and could trigger a double mint.
- **Transfer events are specific and dedupable** — each has a unique tx hash, block number, and sender.

How it works:
1. When a mint request is created, `watchFromBlock` (current block) is persisted in state
2. Payment monitor scans `Transfer(from, to=depositAddress)` events starting from `watchFromBlock`
3. Only transfers with `amount >= expected` are considered
4. The matching transfer's `txHash` is recorded in state as proof of payment — re-scanning the same block range is safe because the same txHash won't trigger a second mint
5. Before calling `mintPod()`, a final `hasProcessed(tweetId)` check provides a cross-process safety net

This means:
- **Restarts are safe** — old transfers before `watchFromBlock` are ignored
- **Re-scans are safe** — duplicate txHash detection prevents double-processing
- **Cross-flow is safe** — file-based dedup catches ACP + mention collisions
- `balanceOf` is only used in the sweep step (to confirm there's something to sweep)

**Sweep caveat**: Deposit addresses need ETH for gas to transfer USDC out. The sweep function sends a tiny ETH amount (~0.0001) from the main wallet first, then transfers USDC back. Acceptable cost on Base.

### Subnet Selection

1. Claude extracts subnet hint from mention text (e.g., "mint this in crypto subnet")
2. Resolve name → ID using existing `getSubnets()` logic
3. Fall back to `DEFAULT_SUBNET_ID` from config
4. If no default, reply asking user to specify

### Rate Limiting

- Max 25 replies per 15-minute window (under Twitter's 50/15min limit)
- 45-second mention polling interval (~20 requests/15min, under the mentions endpoint limit)
- In-memory set of replied mention IDs prevents double-processing
- Persisted `sinceId` prevents reprocessing across restarts
- Shared dedup (`hasProcessed(tweetId)`) prevents double-minting across ACP + mention flows (file-based, works cross-process)

### Personality (System Prompt)

Degen/crypto-native: uses crypto slang (gm, ser, fren, lfg, based, wagmi) naturally but not excessively. Concise and punchy (Twitter-native — under 280 chars). Knowledgeable about Reppo, pods, subnets. Slightly sarcastic but never rude. Never gives financial advice.

## State Machine

```
mention → classify intent
  ├── mint_request → derive address, record watchFromBlock → PENDING_PAYMENT
  │     ├── (Transfer event detected) → record txHash → PAID → MINTING → SUBMITTING_METADATA → COMPLETED → reply + sweep
  │     ├── (timeout 1hr) → EXPIRED → notify user
  │     └── (mint error) → FAILED → notify user
  ├── question → generate reply → reply
  └── irrelevant → skip
```

### Persistence (`src/lib/mention-state.ts`)

State file: `.reppo-mention-state.json` — same patterns as `pending-jobs.ts` (in-memory Map + file locking + periodic persist).

```ts
interface MentionRequest {
  id: string;                         // unique request ID
  mentionId: string;                  // tweet ID of the mention
  tweetUrl: string;                   // tweet URL to mint
  depositAddress: string;             // HD-derived deposit address
  derivationIndex: number;            // HD derivation index
  watchFromBlock: bigint;             // block number when request was created — only scan Transfer events after this
  paymentTxHash?: string;             // Transfer event tx hash — proof of payment, prevents double-processing
  buyerAddress?: string;              // sender from Transfer event
  subnetId?: number;
  status: MentionRequestStatus;
  createdAt: string;
  updatedAt: string;
}

interface MentionListenerState {
  sinceId?: string;                   // resume from last seen mention
  lastPollAt?: string;
  nextDerivationIndex: number;        // monotonically increasing, never reuse
  activeRequests: MentionRequest[];   // pending_payment / paid / minting
  completedRequestIds: string[];      // trimmed to last 2000
}
```

## Implementation Order

**Phase 1 — Foundation** (types, config, state persistence)
1. `src/types.ts` — new interfaces
2. `src/constants.ts` — USDC_DECIMALS, ERC20_ABI additions
3. `src/config.ts` — new env vars with defaults
4. `src/lib/mention-state.ts` — WAL for mention requests

**Phase 2 — Twitter + HD Wallet**
5. `src/twitter.ts` — add `fetchMentions()` and `replyToTweet()`
6. `src/mentions/payment.ts` — HD derivation, USDC balance check, sweep

**Phase 3 — Claude Integration**
7. `src/mentions/prompts.ts` — system prompt + templates
8. `src/mentions/intent.ts` — classification + reply generation

**Phase 4 — Pipeline**
9. `src/mentions/pipeline.ts` — `startMintRequest()`, `paymentMonitorLoop()`, `executeMint()`
10. `src/mentions/listener.ts` — mention poll loop, intent dispatch

**Phase 5 — Server Entry Point**
11. `src/mention-server.ts` — boot Twitter client, init state, start loops, graceful shutdown

**Phase 6 — Tests**
12. Unit tests for each new module (mock Claude, mock Twitter, mock chain)

## Running

```bash
# ACP agent (existing, unchanged)
npx tsx src/index.ts

# Mention server (new, separate process)
npx tsx src/mention-server.ts
```

Both can run on the same machine or separate hosts — they only share the filesystem for dedup/state and the same RPC + contract config.

## Verification

1. `npx tsc --noEmit` — clean build
2. `npx vitest run` — all tests pass
3. Manual test: start mention server, mention @reppodant with a tweet URL, verify deposit address reply, send USDC, verify mint + result reply
4. Verify ACP agent still works independently with no changes

## Risks

| Risk | Mitigation |
|------|-----------|
| Twitter OAuth app needs Read+Write permissions | Verify in Developer Portal before starting |
| HD wallet seed compromise → all deposit addresses exposed | Separate mnemonic from PRIVATE_KEY, same security posture |
| Deposit address needs ETH for sweep | Sweep fn sends tiny ETH from main wallet first (~$0.001 on Base) |
| Claude hallucinates a tweet URL | Independently validate against `TWITTER_URL_REGEX` + `fetchTweet()` |
| Payment received but mint fails | USDC stays in deposit address. v1: manual refund. v2: automated refund sweep |
| Rate limits on mentions endpoint | 45s polling is conservative. Cache `client.v2.me()` result |
| Cross-process dedup race condition | File-based dedup with locking (existing pattern in `pending-jobs.ts`) handles this |
