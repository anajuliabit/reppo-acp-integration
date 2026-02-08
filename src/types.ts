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
}

export interface AcpDeliverable {
  postUrl: string;
  txHash: string;
  podId?: string;
  basescanUrl: string;
  reppoUrl?: string;
}
