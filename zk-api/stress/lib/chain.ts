import { createPublicClient, http, type Address, type PublicClient } from "viem";

import { credentialRegistryAbi } from "../../src/lib/abi.js";
import { LOCAL_RPC_URL } from "./env.js";

export function nodeClient(url = LOCAL_RPC_URL): PublicClient {
  return createPublicClient({ transport: http(url, { retryCount: 0 }) }) as PublicClient;
}

export interface LeafEvent {
  blockNumber: bigint;
  logIndex: number;
  leafIndex: number;
  commitment: string;
  inserted: boolean;
  txHash: string;
}

/// Read straight from the node, never through the service or the fault proxy.
export async function leafEvents(client: PublicClient, registry: Address, fromBlock: bigint): Promise<LeafEvent[]> {
  const logs = await client.getContractEvents({
    address: registry,
    abi: credentialRegistryAbi,
    eventName: "CredentialLeafUpdated",
    fromBlock,
    toBlock: "latest",
  });
  return logs.map((log) => ({
    blockNumber: log.blockNumber!,
    logIndex: log.logIndex!,
    leafIndex: Number(log.args.leafIndex),
    commitment: String(log.args.commitment),
    inserted: Boolean(log.args.inserted),
    txHash: log.transactionHash!,
  }));
}

export async function issuerNonce(client: PublicClient, issuer: Address): Promise<number> {
  return client.getTransactionCount({ address: issuer, blockTag: "latest" });
}
