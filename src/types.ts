import type { Hash, TransactionReceipt, PublicClient, Transport, Chain } from 'viem';
import type { WalletClient } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

export interface AgentSession {
  agentId: string;
  accessToken: string;
}

export interface RegisterAgentResponse {
  data: { id: string; accessToken: string };
}

export interface RegisterPodResponse {
  data: { id: string };
}

export interface MintResult {
  txHash: Hash;
  receipt: TransactionReceipt;
  podId?: bigint;
}

export interface SubmitMetadataParams {
  txHash: Hash;
  title: string;
  description?: string;
  url: string;
  imageURL?: string;
  tokenId?: number;
  category?: string;
  subnet: string;
}

export interface Clients {
  account: PrivateKeyAccount;
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, PrivateKeyAccount>;
}

export interface TweetData {
  id: string;
  text: string;
  authorId: string;
  authorUsername: string;
  createdAt?: string;
  mediaUrls: string[];
}

export interface AcpJobPayload {
  postUrl: string;
  subnet: string;
  agentName?: string;
  agentDescription?: string;
}

export interface AcpDeliverable {
  postUrl: string;
  subnet: string;
  txHash: string;
  podId?: string;
  basescanUrl: string;
  reppoUrl?: string;
}

/**
 * ACP Job structure from @virtuals-protocol/acp-node
 * Based on SDK types - update if SDK provides better types
 */
export interface AcpJobMemo {
  id?: string;
  type?: string;
  content: string | Record<string, unknown>;
  sender?: string;
  timestamp?: number;
}

export interface AcpJob {
  id?: string | number;
  phase?: number;
  memos?: AcpJobMemo[];
  // Buyer/client identification - check actual SDK for correct field
  clientAddress?: string;
  buyerAddress?: string;
  client?: { address?: string; entityId?: number };
  buyer?: { address?: string; entityId?: number };
  // Job lifecycle methods
  accept: (message: string) => Promise<void>;
  reject: (reason: string) => Promise<void>;
  deliver: (deliverable: AcpDeliverable) => Promise<void>;
  evaluate: (approved: boolean, reason: string) => Promise<void>;
}

/**
 * Parsed job content from memos
 */
export interface ParsedJobContent {
  postUrl?: string;
  subnet?: string;
  agentName?: string;
  agentDescription?: string;
}

/**
 * Dedup state persisted to disk
 */
export interface DedupState {
  processedTweets: string[];
  lastUpdated: string;
}
