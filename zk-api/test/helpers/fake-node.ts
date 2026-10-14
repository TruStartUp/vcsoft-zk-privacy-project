import {
  HttpRequestError,
  RpcRequestError,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  hexToBigInt,
  keccak256,
  numberToHex,
  parseTransaction,
  type Address,
  type Hex,
  type Transport,
} from "viem";

import { config } from "../../src/config/index.js";
import { complianceAttestorAbi, credentialRegistryAbi } from "../../src/lib/abi.js";

const abi = [...credentialRegistryAbi, ...complianceAttestorAbi];
const URL = "http://fake-node.invalid";
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

export interface RecordedCall {
  method: string;
  params: unknown[];
  at: number;
}

interface StoredLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

interface SentTransaction {
  hash: Hex;
  raw: Hex;
  nonce: number;
  functionName: string;
  args: readonly unknown[];
  pollsBeforeMined: number;
  hiddenReceiptLookups: number;
  minedAt: bigint | null;
  logs: StoredLog[];
}

type Failure = { method?: string; error: () => Error };

export function httpError(status: number): Error {
  return new HttpRequestError({ url: URL, status, body: {}, details: status === 429 ? "Too Many Requests" : "Bad Gateway" });
}

export function rpcError(code: number, message: string, data?: Hex): Error {
  return new RpcRequestError({ url: URL, body: {}, error: { code, message, data } });
}

export function revertError(errorName: string, args: readonly unknown[]): Error {
  return rpcError(3, "execution reverted", encodeErrorResult({ abi: credentialRegistryAbi, errorName, args } as never));
}

/// A scripted JSON-RPC node behind the real viem clients. It keeps just enough of
/// the registry to answer what the service asks -- the current roots and the leaf
/// event log -- and lets a test make it slow, lagging, rate limited or picky about
/// log ranges, which is what a public endpoint is.
export class FakeNode {
  head = 100n;
  reportedLag = 0n;
  advanceOnBlockNumber = false;
  pollsBeforeMined = 0;
  neverMine = false;
  staleNonce = false;
  /// Mines on arrival but keeps the receipt from lookups this many times, as a node
  /// behind a balancer that indexed the transaction before its receipt does.
  receiptLagLookups = 0;
  /// What a resend of a transaction the node already has gets back.
  knownTransactionError = "already known";
  maxLogRange: bigint | null = null;
  credentialRoot = 0n;
  readonly registry: Address = config.chain.credentialRegistryAddress;
  readonly calls: RecordedCall[] = [];
  readonly logs: StoredLog[] = [];
  readonly sent: SentTransaction[] = [];
  readonly failures: Failure[] = [];
  readonly droppedResponses: string[] = [];
  views: Record<string, (args: readonly unknown[], block: unknown) => unknown> = {};
  estimate: (functionName: string, args: readonly unknown[], block: unknown) => bigint = () => 100_000n;
  private nonce = 0;

  transport(): Transport {
    return custom({ request: (args: { method: string; params?: unknown[] }) => this.handle(args) }, { retryCount: 0 });
  }

  failNext(times: number, error: () => Error, method?: string): void {
    for (let i = 0; i < times; i++) this.failures.push({ method, error });
  }

  /// The node handles the next call to `method` and the response is lost on the way
  /// back, the way a gateway timeout loses it.
  dropNextResponse(method: string): void {
    this.droppedResponses.push(method);
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  addCredentialLeafLog(blockNumber: bigint, logIndex: number, event: { newRoot: bigint; leafIndex: bigint; commitment: bigint; inserted: boolean }) {
    this.logs.push({
      address: this.registry,
      topics: encodeEventTopics({
        abi: credentialRegistryAbi,
        eventName: "CredentialLeafUpdated",
        args: { newRoot: event.newRoot, leafIndex: event.leafIndex, commitment: event.commitment },
      }) as Hex[],
      data: encodeAbiParameters([{ type: "bool" }], [event.inserted]),
      blockNumber,
      logIndex,
      transactionHash: keccak256(numberToHex(blockNumber * 1000n + BigInt(logIndex))),
    });
  }

  private async handle({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
    this.calls.push({ method, params, at: Date.now() });
    const index = this.failures.findIndex((failure) => !failure.method || failure.method === method);
    if (index >= 0) {
      const [failure] = this.failures.splice(index, 1);
      throw failure!.error();
    }

    const result = await this.answer(method, params);
    const dropped = this.droppedResponses.indexOf(method);
    if (dropped >= 0) {
      this.droppedResponses.splice(dropped, 1);
      throw httpError(504);
    }
    return result;
  }

  private async answer(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return numberToHex(config.chain.chainId);
      case "eth_blockNumber":
        if (this.advanceOnBlockNumber) this.head += 1n;
        return numberToHex(this.head - this.reportedLag);
      case "eth_getBlockByNumber":
        return this.block(params[0], params[1] === true);
      case "eth_maxPriorityFeePerGas":
      case "eth_gasPrice":
        return "0x1";
      case "eth_getTransactionCount":
        return numberToHex(this.staleNonce ? 0 : this.nonce);
      case "eth_getCode":
        return "0x";
      case "eth_call":
        return this.call(params[0] as { data: Hex }, params[1]);
      case "eth_estimateGas": {
        const { functionName, args } = decodeFunctionData({ abi, data: (params[0] as { data: Hex }).data });
        return numberToHex(this.estimate(functionName, args ?? [], params[1]));
      }
      case "eth_sendRawTransaction":
        return this.send(params[0] as Hex);
      case "eth_getTransactionByHash":
        return this.transaction(params[0] as Hex);
      case "eth_getTransactionReceipt":
        return this.receipt(params[0] as Hex);
      case "eth_getLogs":
        return this.getLogs(params[0] as { address?: Address; topics?: (Hex | null)[]; fromBlock: Hex; toBlock: Hex });
      default:
        throw rpcError(-32601, `method ${method} not found`);
    }
  }

  private block(tag?: unknown, includeTransactions = false) {
    const number = typeof tag === "string" && tag.startsWith("0x") ? hexToBigInt(tag as Hex) : this.head;
    return {
      number: numberToHex(number),
      hash: keccak256(numberToHex(number)),
      parentHash: ZERO_HASH,
      nonce: "0x0000000000000000",
      sha3Uncles: ZERO_HASH,
      logsBloom: `0x${"0".repeat(512)}`,
      transactionsRoot: ZERO_HASH,
      stateRoot: ZERO_HASH,
      receiptsRoot: ZERO_HASH,
      miner: "0x0000000000000000000000000000000000000000",
      difficulty: "0x0",
      totalDifficulty: "0x0",
      extraData: "0x",
      size: "0x0",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      timestamp: numberToHex(1_790_000_000n + number * 2n),
      baseFeePerGas: "0x1",
      transactions: includeTransactions
        ? this.sent.filter((entry) => entry.minedAt === number).map((entry) => this.transaction(entry.hash))
        : [],
      uncles: [],
    };
  }

  private call({ data }: { data: Hex }, block: unknown): Hex {
    const { functionName, args } = decodeFunctionData({ abi, data });
    const view = this.views[functionName];
    const result = view ? view(args ?? [], block) : functionName === "credentialRoot" ? this.credentialRoot : 0n;
    return encodeFunctionResult({ abi, functionName, result } as never);
  }

  private send(raw: Hex): Hex {
    const transaction = parseTransaction(raw);
    const { functionName, args } = decodeFunctionData({ abi: credentialRegistryAbi, data: transaction.data! });
    const hash = keccak256(raw);
    if (this.sent.some((entry) => entry.hash === hash)) throw rpcError(-32000, this.knownTransactionError);
    this.nonce = Math.max(this.nonce, (transaction.nonce ?? 0) + 1);
    const entry: SentTransaction = {
      hash,
      raw,
      nonce: transaction.nonce ?? 0,
      functionName,
      args: args ?? [],
      pollsBeforeMined: this.pollsBeforeMined,
      hiddenReceiptLookups: this.receiptLagLookups,
      minedAt: null,
      logs: [],
    };
    this.sent.push(entry);
    if (entry.hiddenReceiptLookups > 0) this.mine(entry);
    return hash;
  }

  private mine(sent: SentTransaction): void {
    this.head += 1n;
    sent.minedAt = this.head;
    if (sent.functionName === "publishCredentialRoot") {
      const [newRoot, updates] = sent.args as [bigint, { leafIndex: bigint; commitment: bigint; inserted: boolean }[]];
      updates.forEach((update, logIndex) => {
        this.addCredentialLeafLog(this.head, logIndex, { newRoot, ...update });
        sent.logs.push({ ...this.logs.at(-1)!, transactionHash: sent.hash });
      });
      const published = {
        address: this.registry,
        topics: encodeEventTopics({
          abi: credentialRegistryAbi,
          eventName: "CredentialRootPublished",
          args: { newRoot, previousRoot: this.credentialRoot },
        }) as Hex[],
        data: encodeAbiParameters([{ type: "uint256" }], [this.head * 2n]),
        blockNumber: this.head,
        logIndex: updates.length,
        transactionHash: sent.hash,
      };
      sent.logs.push(published);
      this.logs.push(published);
      this.credentialRoot = newRoot;
    }
  }

  private transaction(hash: Hex) {
    const sent = this.sent.find((entry) => entry.hash === hash);
    if (!sent) return null;
    const parsed = parseTransaction(sent.raw);
    return {
      hash,
      from: "0x0000000000000000000000000000000000000001",
      to: parsed.to,
      nonce: numberToHex(sent.nonce),
      input: parsed.data,
      value: "0x0",
      gas: numberToHex(parsed.gas ?? 0n),
      maxFeePerGas: "0x2",
      maxPriorityFeePerGas: "0x1",
      type: "0x2",
      chainId: numberToHex(config.chain.chainId),
      accessList: [],
      blockHash: sent.minedAt ? keccak256(numberToHex(sent.minedAt)) : null,
      blockNumber: sent.minedAt ? numberToHex(sent.minedAt) : null,
      transactionIndex: sent.minedAt ? "0x0" : null,
      v: "0x0",
      r: "0x1",
      s: "0x1",
      yParity: "0x0",
    };
  }

  private receipt(hash: Hex) {
    const sent = this.sent.find((entry) => entry.hash === hash);
    if (!sent) return null;
    if (sent.hiddenReceiptLookups > 0) {
      sent.hiddenReceiptLookups -= 1;
      return null;
    }
    if (sent.minedAt === null) {
      if (this.neverMine) return null;
      if (sent.pollsBeforeMined > 0) {
        sent.pollsBeforeMined -= 1;
        return null;
      }
      this.mine(sent);
    }
    const blockHash = keccak256(numberToHex(sent.minedAt!));
    return {
      transactionHash: hash,
      transactionIndex: "0x0",
      blockHash,
      blockNumber: numberToHex(sent.minedAt!),
      from: "0x0000000000000000000000000000000000000001",
      to: this.registry,
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x1",
      contractAddress: null,
      logsBloom: `0x${"0".repeat(512)}`,
      status: "0x1",
      type: "0x2",
      logs: sent.logs.map((log) => this.formatLog(log, blockHash)),
    };
  }

  private formatLog(log: StoredLog, blockHash: Hex = keccak256(numberToHex(log.blockNumber))) {
    return {
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: numberToHex(log.blockNumber),
      blockHash,
      logIndex: numberToHex(log.logIndex),
      transactionHash: log.transactionHash,
      transactionIndex: "0x0",
      removed: false,
    };
  }

  private getLogs(filter: { address?: Address; topics?: (Hex | null)[]; fromBlock: Hex; toBlock: Hex }) {
    const from = hexToBigInt(filter.fromBlock);
    const to = hexToBigInt(filter.toBlock);
    if (this.maxLogRange !== null && to - from + 1n > this.maxLogRange) {
      throw rpcError(-32600, `block range too large: at most ${this.maxLogRange} blocks per query`);
    }
    return this.logs
      .filter((log) => log.blockNumber >= from && log.blockNumber <= to)
      .filter((log) => !filter.address || log.address.toLowerCase() === filter.address.toLowerCase())
      .filter((log) => (filter.topics ?? []).every((topic, i) => topic === null || topic === undefined || log.topics[i] === topic))
      .reverse()
      .map((log) => this.formatLog(log));
  }
}
