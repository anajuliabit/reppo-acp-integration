import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface PodRecord {
  podId: number;
  buyerWallet: string;
  buyerAgentId?: string;
  mintTxHash: string;
  createdAt: string;
  claimedAt?: string;
  claimedAmount?: bigint;
}

type PodStore = Record<number, PodRecord>;

let PODS_FILE = '';

export function initPodsFile(dataDir: string): void {
  PODS_FILE = join(dataDir, '.reppo-pods.json');
}

function loadPods(): PodStore {
  if (!existsSync(PODS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(PODS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function savePods(store: PodStore): void {
  writeFileSync(PODS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function savePod(
  podId: number,
  buyerWallet: string,
  mintTxHash: string,
  buyerAgentId?: string,
): void {
  const pods = loadPods();
  pods[podId] = {
    podId,
    buyerWallet,
    buyerAgentId,
    mintTxHash,
    createdAt: new Date().toISOString(),
  };
  savePods(pods);
}

export function getPod(podId: number): PodRecord | null {
  const pods = loadPods();
  return pods[podId] ?? null;
}

export function getPodsByWallet(buyerWallet: string): PodRecord[] {
  const pods = loadPods();
  return Object.values(pods).filter((p) => p.buyerWallet === buyerWallet);
}

export function getUnclaimedPods(): PodRecord[] {
  const pods = loadPods();
  return Object.values(pods).filter((p) => !p.claimedAt);
}

export function markPodClaimed(podId: number, amount: bigint): void {
  const pods = loadPods();
  if (pods[podId]) {
    pods[podId].claimedAt = new Date().toISOString();
    pods[podId].claimedAmount = amount;
    savePods(pods);
  }
}
