import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ethers, network } from "hardhat";
import type { TransactionReceipt, TransactionResponse } from "ethers";

export const CONFIRMATIONS = 2;
const RECEIPT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ContractRecord {
  address: string;
  txHash: string;
  block: number;
}

export interface TransactionRecord {
  hash: string;
  from: string;
  signer: string;
  status: "pending" | "confirmed";
  block?: number;
  gasUsed?: string;
  effectiveGasPrice?: string;
  l1Fee?: string;
  feeWei?: string;
  contractAddress?: string;
}

export interface Deployment {
  network: string;
  chainId: number;
  parameters: Record<string, unknown>;
  external: Record<string, string>;
  contracts: Record<string, ContractRecord>;
  transactions: Record<string, TransactionRecord>;
}

export function deploymentPath(): string {
  return join(__dirname, "..", "..", "deployments", `${network.name}.json`);
}

export function displayPath(path: string): string {
  return relative(join(__dirname, "..", ".."), path);
}

export function loadDeployment(): Deployment | undefined {
  const path = deploymentPath();
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

export function requireDeployment(): Deployment {
  const deployment = loadDeployment();
  if (deployment === undefined) throw new Error(`no deployment recorded for network ${network.name}`);
  return deployment;
}

export function saveDeployment(deployment: Deployment): void {
  const path = deploymentPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(deployment, null, 2)}\n`);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/// The public RPC is load balanced and can answer from a node a few blocks behind.
export async function pollUntil<T>(
  label: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  attempts = 40,
  delayMs = 3000,
): Promise<T> {
  let last: T | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      if (attempt === attempts) throw error;
    }
    await sleep(delayMs);
  }
  throw new Error(`${label}: state not reflected after ${attempts} reads (last: ${String(last)})`);
}

async function confirmedReceipt(hash: string): Promise<TransactionReceipt> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await ethers.provider.getTransactionReceipt(hash).catch(() => null);
    if (receipt !== null) {
      const head = await ethers.provider.getBlockNumber();
      if (head - receipt.blockNumber + 1 >= CONFIRMATIONS) return receipt;
    }
    await sleep(2000);
  }
  throw new Error(`no receipt with ${CONFIRMATIONS} confirmations for ${hash}`);
}

async function l1FeeOf(hash: string): Promise<bigint> {
  const raw = await ethers.provider.send("eth_getTransactionReceipt", [hash]);
  return raw?.l1Fee ? BigInt(raw.l1Fee) : 0n;
}

export class TransactionLedger {
  constructor(private readonly deployment: Deployment) {}

  isDone(key: string): boolean {
    return this.deployment.transactions[key]?.status === "confirmed";
  }

  record(key: string): TransactionRecord | undefined {
    return this.deployment.transactions[key];
  }

  /// A hash is written down before waiting for it, so an interrupted run resumes the same
  /// transaction instead of sending a second one.
  async run(
    key: string,
    signerLabel: string,
    send: () => Promise<TransactionResponse>,
  ): Promise<TransactionReceipt | undefined> {
    const existing = this.deployment.transactions[key];
    if (existing?.status === "confirmed") {
      console.log(`  skip ${key} (tx ${existing.hash})`);
      return undefined;
    }

    let hash = existing?.hash;
    if (hash === undefined) {
      const tx = await send();
      hash = tx.hash;
      this.deployment.transactions[key] = { hash, from: tx.from, signer: signerLabel, status: "pending" };
      saveDeployment(this.deployment);
      console.log(`  sent ${key} tx ${hash} from ${signerLabel} ${tx.from}`);
    } else {
      console.log(`  resuming ${key} tx ${hash}`);
    }

    const receipt = await confirmedReceipt(hash);
    if (receipt.status !== 1) throw new Error(`${key}: transaction ${hash} reverted`);

    const l1Fee = await l1FeeOf(hash);
    const effectiveGasPrice = receipt.gasPrice;
    const record: TransactionRecord = {
      ...this.deployment.transactions[key],
      status: "confirmed",
      block: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: effectiveGasPrice.toString(),
      l1Fee: l1Fee.toString(),
      feeWei: (receipt.gasUsed * effectiveGasPrice + l1Fee).toString(),
    };
    if (receipt.contractAddress) record.contractAddress = receipt.contractAddress;
    this.deployment.transactions[key] = record;
    saveDeployment(this.deployment);
    console.log(`  confirmed ${key} block ${receipt.blockNumber} gas ${receipt.gasUsed} fee ${ethers.formatEther(record.feeWei!)} ETH`);
    return receipt;
  }
}
