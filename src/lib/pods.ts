import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createLogger } from './logger.js';

const log = createLogger('pods');

const TABLE_NAME = 'reppo-pods';

let client: DynamoDBClient | null = null;
let docClient: DynamoDBDocumentClient | null = null;

export function initPods(config: { DYNAMODB_ENDPOINT?: string; AWS_REGION?: string }): void {
  const endpoint = config.DYNAMODB_ENDPOINT;
  const region = config.AWS_REGION || 'us-east-1';
  
  client = new DynamoDBClient({
    endpoint,
    region,
    ...(endpoint ? { tls: false, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
  });
  
  docClient = DynamoDBDocumentClient.from(client);
  log.info({ endpoint: endpoint ?? 'aws', region }, 'DynamoDB client initialized');
}

export interface PodRecord {
  podId: number;
  buyerWallet: string;
  buyerAgentId?: string;
  mintTxHash: string;
  jobId?: number;
  createdAt: string;
  claimedAt?: string;
  claimedAmount?: number;
}

async function getDocClient(): Promise<DynamoDBDocumentClient> {
  if (!docClient) {
    throw new Error('DynamoDB not initialized. Call initPods() first.');
  }
  return docClient;
}

export async function savePod(
  podId: number,
  buyerWallet: string,
  mintTxHash: string,
  buyerAgentId?: string,
  jobId?: number,
): Promise<void> {
  const dc = await getDocClient();
  await dc.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      podId,
      buyerWallet,
      buyerAgentId,
      mintTxHash,
      jobId,
      createdAt: new Date().toISOString(),
      claimed: false,
    },
  }));
  log.info({ podId, buyerWallet, jobId }, 'Pod saved to DynamoDB');
}

/**
 * Check if a job was already minted by scanning for its jobId in DynamoDB
 */
export async function getJobMint(jobId: number): Promise<PodRecord | null> {
  const dc = await getDocClient();
  const result = await dc.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'jobId = :jid',
    ExpressionAttributeValues: { ':jid': jobId },
    Limit: 1,
  }));
  return (result.Items?.[0] as PodRecord | undefined) ?? null;
}

export async function getPod(podId: number): Promise<PodRecord | null> {
  const dc = await getDocClient();
  const result = await dc.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { podId },
  }));
  return (result.Item as PodRecord | undefined) ?? null;
}

export async function getPodsByWallet(buyerWallet: string): Promise<PodRecord[]> {
  const dc = await getDocClient();
  const result = await dc.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'buyerWallet-index',
    KeyConditionExpression: 'buyerWallet = :wallet',
    ExpressionAttributeValues: { ':wallet': buyerWallet },
  }));
  return (result.Items ?? []) as PodRecord[];
}

export async function getUnclaimedPods(): Promise<PodRecord[]> {
  const dc = await getDocClient();
  const result = await dc.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'claimed = :false',
    ExpressionAttributeValues: { ':false': false },
  }));
  return (result.Items ?? []) as PodRecord[];
}

export async function markPodClaimed(podId: number, amount: number): Promise<void> {
  const dc = await getDocClient();
  await dc.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { podId },
    UpdateExpression: 'SET claimed = :true, claimedAt = :at, claimedAmount = :amt',
    ExpressionAttributeValues: {
      ':true': true,
      ':at': new Date().toISOString(),
      ':amt': amount,
    },
  }));
  log.info({ podId, amount }, 'Pod marked as claimed');
}
