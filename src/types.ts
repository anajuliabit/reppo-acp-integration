import type { Hash, TransactionReceipt, PublicClient, Transport, Chain } from 'viem';
import type { WalletClient } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { AcpContractClientV2 } from '@virtuals-protocol/acp-node';

export interface AgentSession {
  agentId: string;
  accessToken: string;
  walletAddress?: string;
}

export interface RegisterAgentResponse {
  data: { id: string; accessToken: string; walletAddress: string };
}

export interface SubnetConfig {
  [key: string]: unknown;
}

export type SubnetsResponse = SubnetConfig[];

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
  imageUrl?: string;
  tokenId?: number;
  category?: string;
  subnetId?: string;
}

export interface Clients {
  account: PrivateKeyAccount;
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, PrivateKeyAccount>;
  contractClient?: InstanceType<typeof AcpContractClientV2>;
  aaWalletAddress?: `0x${string}`;
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
  // Pricing
  price?: number;
  priceValue?: number;
  priceTokenAddress?: string;
  netPayableAmount?: number;
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
  podName?: string;
  podDescription?: string;
}

/**
 * Dedup state persisted to disk
 */
export interface DedupState {
  processedTweets: string[];
  mintedJobs?: string[];
  lastUpdated: string;
}

/**
 * Pending job write-ahead log
 */
export type PendingJobStatus = 'accepted' | 'minted' | 'completed';

export interface PendingJob {
  jobId: string;
  tweetId: string;
  postUrl: string;
  subnet: string;
  buyerId: string | null;
  agentName?: string;
  agentDescription?: string;
  podName?: string;
  podDescription?: string;
  status: PendingJobStatus;
  mintTxHash?: string;
  podId?: number;
  createdAt: string;
  updatedAt: string;
  retryCount: number;
  lastError?: string;
}
