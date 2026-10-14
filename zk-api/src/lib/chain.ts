import {
  BaseError,
  HttpRequestError,
  TimeoutError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  type Address,
  type Hex,
  type NonceManager,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { jsonRpc } from "viem/nonce";

import { config } from "../config/index.js";

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
}

export interface ChainSettings {
  confirmations: number;
  receiptTimeoutMs: number;
  pollingIntervalMs: number;
  logBlockRange: number;
  retry: RetryPolicy;
}

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_RPC_CODES = new Set([-32005, -32603, -32002, 429]);
const TRANSIENT_TEXT =
  /rate.?limit|too many requests|exceeded its .*capacity|compute units|timed? ?out|timeout|header not found|unknown block|missing trie node|temporarily unavailable|try again|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error/i;
const REVERT_TEXT = /revert/i;
const RANGE_TOO_LARGE_TEXT =
  /block range|range (is )?too (large|wide|big)|more than \d+ (results|logs|blocks)|query returned more than|exceeds? (the )?max(imum)? (block )?range|limited to \d+ blocks?/i;
const ALREADY_KNOWN_TEXT = /already known|known transaction|already imported/i;
const NONCE_TOO_LOW_TEXT = /nonce too low|nonce (provided )?(for the transaction )?is lower than|nonce has already been used/i;
const MAX_RETRY_AFTER_MS = 30_000;

interface ErrorLike {
  name?: string;
  code?: unknown;
  shortMessage?: string;
  details?: string;
  message?: string;
  data?: unknown;
  cause?: unknown;
}

function causes(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  let current: unknown = error;
  while (current && typeof current === "object" && chain.length < 16) {
    chain.push(current as ErrorLike);
    current = (current as ErrorLike).cause;
  }
  return chain;
}

/// Viem's full message carries the request URL, which may embed a provider key.
/// Only the short message and the node's own details are ever inspected or returned.
function textOf(error: ErrorLike): string {
  if (error instanceof BaseError) return `${error.shortMessage} ${error.details ?? ""}`;
  return `${error.shortMessage ?? ""} ${error.details ?? ""} ${error.message ?? ""}`;
}

export function describeChainError(error: unknown): string {
  const [first] = causes(error);
  if (!first) return String(error);
  return (first instanceof BaseError ? first.shortMessage : (first.message ?? String(error))).slice(0, 500);
}

export function isRevertError(error: unknown): boolean {
  return causes(error).some(
    (e) =>
      e.code === 3 ||
      e.name === "ContractFunctionRevertedError" ||
      e.name === "ExecutionRevertedError" ||
      REVERT_TEXT.test(textOf(e)),
  );
}

export function isRangeTooLargeError(error: unknown): boolean {
  return causes(error).some((e) => RANGE_TOO_LARGE_TEXT.test(textOf(e)));
}

/// Retried: rate limiting, gateway failures, timeouts, dropped connections and a
/// node that has not caught up with a block yet. Never retried: a revert, which is
/// the contract's answer and would be the same answer again.
export function isTransientRpcError(error: unknown): boolean {
  if (isRevertError(error) || isRangeTooLargeError(error)) return false;
  for (const e of causes(error)) {
    if (e instanceof HttpRequestError) {
      return e.status === undefined || TRANSIENT_HTTP_STATUSES.has(e.status);
    }
    if (e instanceof TimeoutError) return true;
    if (typeof e.code === "number" && TRANSIENT_RPC_CODES.has(e.code)) return true;
    if (TRANSIENT_TEXT.test(textOf(e))) return true;
  }
  return false;
}

function retryAfterMs(error: unknown): number {
  for (const e of causes(error)) {
    if (e instanceof HttpRequestError) {
      const seconds = Number(e.headers?.get("Retry-After"));
      if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }
  return 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/// Wraps a transport so every JSON-RPC call is retried on transient failures with
/// exponential backoff, up to a fixed number of attempts. A raw transaction resent
/// after a lost response may come back as "already known" -- the node has it -- or,
/// if it was mined in between, as "nonce too low". Either way, when the node knows the
/// hash of the bytes that were sent, that transaction is the one that went out.
export function retryingTransport(inner: Transport, policy: RetryPolicy): Transport {
  return ((parameters: Parameters<Transport>[0]) => {
    const base = inner({ ...parameters, retryCount: 0 });
    const request = async (args: { method: string; params?: unknown }, options?: object): Promise<unknown> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await base.request(args as never, { ...options, retryCount: 0 } as never);
        } catch (error) {
          if (attempt > 0 && args.method === "eth_sendRawTransaction") {
            const hash = keccak256((args.params as [Hex])[0]);
            if (causes(error).some((e) => ALREADY_KNOWN_TEXT.test(textOf(e)))) return hash;
            if (causes(error).some((e) => NONCE_TOO_LOW_TEXT.test(textOf(e)))) {
              const known = await request({ method: "eth_getTransactionByHash", params: [hash] }, options).catch(() => null);
              if (known) return hash;
            }
          }
          if (attempt >= policy.maxRetries || !isTransientRpcError(error)) throw error;
          await sleep(Math.max(policy.baseDelayMs * 2 ** attempt, retryAfterMs(error)));
        }
      }
    };
    return { ...base, request: request as typeof base.request };
  }) as Transport;
}

const chain = defineChain({
  id: config.chain.chainId,
  name: `evm-${config.chain.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.chain.rpcUrl] } },
});

const defaultSettings: ChainSettings = {
  confirmations: config.chain.confirmations,
  receiptTimeoutMs: config.chain.receiptTimeoutMs,
  pollingIntervalMs: config.chain.pollingIntervalMs,
  logBlockRange: config.chain.logBlockRange,
  retry: { maxRetries: config.chain.rpcMaxRetries, baseDelayMs: config.chain.rpcRetryBaseMs },
};

let settings: ChainSettings = defaultSettings;
let transportOverride: Transport | undefined;
let publicClientInstance: PublicClient | undefined;
let walletClientInstance: WalletClient | undefined;
let accountInstance: PrivateKeyAccount | undefined;
let writeFloor = 0n;

export function chainSettings(): ChainSettings {
  return settings;
}

/// Points the clients at another transport and settings. Used by the suite to put a
/// scripted node behind the real client code; production never calls it.
export function configureChain(options: { transport?: Transport; settings?: Partial<ChainSettings> } = {}): void {
  transportOverride = options.transport;
  settings = { ...defaultSettings, ...options.settings };
  publicClientInstance = undefined;
  walletClientInstance = undefined;
  accountInstance = undefined;
  writeFloor = 0n;
}

function transport(): Transport {
  const inner = transportOverride ?? http(config.chain.rpcUrl, { timeout: config.chain.rpcTimeoutMs });
  return retryingTransport(inner, settings.retry);
}

/// Hands out the larger of the node's pending count and the next nonce this process
/// has not used, so a load-balanced node still reporting the count from before a
/// mined transaction cannot hand that nonce out again. A send that fails gives its
/// nonce back, so a failure never leaves a gap that would stall every later write.
/// It assumes one process signs with the issuer key.
export function monotonicNonceManager(): NonceManager {
  const source = jsonRpc();
  const next = new Map<string, number>();
  const lastConsumed = new Map<string, number>();
  const keyOf = ({ address, chainId }: { address: string; chainId: number }) => `${address.toLowerCase()}.${chainId}`;

  const get: NonceManager["get"] = async (parameters) =>
    Math.max(await source.get(parameters), next.get(keyOf(parameters)) ?? 0);

  return {
    get,
    async consume(parameters) {
      const nonce = await get(parameters);
      next.set(keyOf(parameters), nonce + 1);
      lastConsumed.set(keyOf(parameters), nonce);
      return nonce;
    },
    increment(parameters) {
      next.set(keyOf(parameters), (next.get(keyOf(parameters)) ?? 0) + 1);
    },
    reset(parameters) {
      const consumed = lastConsumed.get(keyOf(parameters));
      if (consumed === undefined) next.delete(keyOf(parameters));
      else next.set(keyOf(parameters), consumed);
    },
  };
}

export function issuerAccount(): PrivateKeyAccount {
  accountInstance ??= privateKeyToAccount(config.chain.issuerPrivateKey, { nonceManager: monotonicNonceManager() });
  return accountInstance;
}

export function publicClient(): PublicClient {
  publicClientInstance ??= createPublicClient({
    chain,
    transport: transport(),
    pollingInterval: settings.pollingIntervalMs,
  });
  return publicClientInstance;
}

export function walletClient(): WalletClient {
  walletClientInstance ??= createWalletClient({
    chain,
    account: issuerAccount(),
    transport: transport(),
    pollingInterval: settings.pollingIntervalMs,
  });
  return walletClientInstance;
}

/// The highest block holding a transaction this process confirmed. Reads and gas
/// estimates are never made against an earlier block, whatever `latest` says.
export function noteConfirmedBlock(blockNumber: bigint): void {
  if (blockNumber > writeFloor) writeFloor = blockNumber;
}

export function confirmedBlockFloor(): bigint {
  return writeFloor;
}

export const credentialRegistryAddress = config.chain.credentialRegistryAddress as Address;
export const complianceAttestorAddress = config.chain.complianceAttestorAddress as Address;
