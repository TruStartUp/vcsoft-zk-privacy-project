import {
  BaseError,
  ContractFunctionRevertedError,
  WaitForTransactionReceiptTimeoutError,
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";

import { complianceAttestorAbi, credentialRegistryAbi } from "../lib/abi.js";
import {
  chainSettings,
  complianceAttestorAddress,
  confirmedBlockFloor,
  credentialRegistryAddress,
  describeChainError,
  isRangeTooLargeError,
  isRevertError,
  issuerAccount,
  noteConfirmedBlock,
  publicClient,
  walletClient,
} from "../lib/chain.js";
import { config } from "../config/index.js";
import { apiError, isApiError } from "../lib/errors.js";

export interface CredentialLeafUpdate {
  leafIndex: bigint;
  commitment: bigint;
  inserted: boolean;
}

export interface CountryLeafUpdate {
  leafIndex: bigint;
  countryCode: number;
  admitted: boolean;
}

/// `previousRoot` is the root the registry itself reports having replaced, read
/// from the publication's own receipt. It is null only if the event is missing.
export interface PublishedRoot {
  txHash: Hex;
  blockNumber: bigint;
  previousRoot: bigint | null;
}

export interface CredentialLeafEvent {
  blockNumber: bigint;
  logIndex: number;
  newRoot: bigint;
  leafIndex: number;
  commitment: bigint;
  inserted: boolean;
}

export interface CountryLeafEvent {
  blockNumber: bigint;
  logIndex: number;
  assetId: bigint;
  newRoot: bigint;
  leafIndex: number;
  countryCode: number;
  admitted: boolean;
}

export interface Attestation {
  issuedAt: bigint;
  expiresAt: bigint;
  nullifier: bigint;
}

/// The block a read is answered at. Omitted, it is `latest` as the node sees it.
export interface ReadOptions {
  at?: bigint;
}

export interface LogQueryOptions {
  blockRange?: number;
}

type WriteKind = "publication" | "invalidation";

interface RevertDetails {
  error: string | null;
  args?: string[];
}

function decodeRevert(cause: unknown): RevertDetails | null {
  if (!isRevertError(cause)) return null;
  if (cause instanceof BaseError) {
    const reverted = cause.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted?.data) {
      return { error: reverted.data.errorName, args: (reverted.data.args ?? []).map((arg) => String(arg)) };
    }
    if (reverted?.reason) return { error: reverted.reason };
  }
  return { error: null };
}

function reverted(kind: WriteKind, details: Record<string, unknown>) {
  if (kind === "invalidation") {
    return apiError.failedDependency("root_invalidation_reverted", "the registry refused to drop the root", details);
  }
  return apiError.failedDependency("root_publication_reverted", "the registry reverted the new root", details);
}

function chainFailure(action: string, cause: unknown, details: Record<string, unknown> = {}) {
  return apiError.failedDependency("chain_call_failed", `${action} failed on chain`, {
    ...details,
    reason: describeChainError(cause),
  });
}

function writeFailure(kind: WriteKind, action: string, cause: unknown, details: Record<string, unknown> = {}) {
  if (isApiError(cause)) return cause;
  const revert = decodeRevert(cause);
  if (revert) return reverted(kind, { ...details, revert });
  return chainFailure(action, cause, details);
}

async function read<T>(action: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw chainFailure(action, cause);
  }
}

/// The block every read of one answer is made at: the node's head, or the last
/// block this process saw its own transaction confirmed in if the node is behind
/// it. A node that has not caught up yet answers "unknown block", which is
/// retried, instead of answering from before the write.
export async function stateBlock(): Promise<bigint> {
  const head = await read("getBlockNumber", () => publicClient().getBlockNumber({ cacheTime: 0 }));
  const floor = confirmedBlockFloor();
  return head >= floor ? head : floor;
}

type RegistryWrite =
  | { functionName: "publishCredentialRoot"; args: readonly [bigint, readonly CredentialLeafUpdate[]] }
  | { functionName: "publishCountryRoot"; args: readonly [bigint, bigint, readonly CountryLeafUpdate[]] }
  | { functionName: "invalidateCredentialRoot"; args: readonly [bigint] }
  | { functionName: "invalidateCountryRoot"; args: readonly [bigint, bigint] };

let sending: Promise<unknown> = Promise.resolve();

/// One transaction leaves this process at a time: its nonce is taken and the signed
/// bytes handed to the node before the next one starts. Changes to different trees run
/// under different locks, and without this two of them could take the same nonce.
function sendInTurn<T>(send: () => Promise<T>): Promise<T> {
  const turn = sending.then(send, send);
  sending = turn.catch(() => undefined);
  return turn;
}

/// Estimates at the state block, so a call that depends on this process's previous
/// write is never judged against a node that has not seen it yet, then sends with
/// that limit and waits for the configured confirmations within a fixed time.
async function submit(kind: WriteKind, write: RegistryWrite): Promise<TransactionReceipt> {
  const { confirmations, receiptTimeoutMs, pollingIntervalMs } = chainSettings();
  const account = issuerAccount();
  const contract = { address: credentialRegistryAddress, abi: credentialRegistryAbi, ...write };

  let hash: Hex;
  try {
    const at = await stateBlock();
    const gas = await publicClient().estimateContractGas({ ...contract, account: account.address, blockNumber: at } as never);
    hash = await sendInTurn(() => walletClient().writeContract({ ...contract, account, chain: null, gas: (gas * 6n) / 5n } as never));
  } catch (cause) {
    throw writeFailure(kind, write.functionName, cause);
  }

  let receipt: TransactionReceipt;
  try {
    // No replacement check: nothing else signs with this key, so a missing receipt
    // means "not yet". The check reads a receipt that lags its transaction, as one
    // served by a node behind the balancer does, as a failure of a transaction that
    // was in fact mined.
    receipt = await publicClient().waitForTransactionReceipt({
      hash,
      confirmations,
      timeout: receiptTimeoutMs,
      pollingInterval: pollingIntervalMs,
      checkReplacement: false,
    });
  } catch (cause) {
    if (cause instanceof WaitForTransactionReceiptTimeoutError) {
      throw apiError.failedDependency(
        "chain_receipt_timeout",
        "the transaction was sent and no receipt arrived in time; reconcile before writing again",
        { txHash: hash, timeoutMs: receiptTimeoutMs },
      );
    }
    throw writeFailure(kind, write.functionName, cause, { txHash: hash });
  }

  noteConfirmedBlock(receipt.blockNumber);
  if (receipt.status !== "success") throw reverted(kind, { txHash: hash, revert: { error: null } });
  return receipt;
}

function supersededRoot(receipt: TransactionReceipt, eventName: "CredentialRootPublished" | "CountryRootPublished"): bigint | null {
  const [event] = parseEventLogs({ abi: credentialRegistryAbi, logs: receipt.logs, eventName, strict: true }).filter(
    (log) => log.address.toLowerCase() === credentialRegistryAddress.toLowerCase(),
  );
  return event ? (event.args as { previousRoot: bigint }).previousRoot : null;
}

export async function publishCredentialRoot(
  newRoot: bigint,
  updates: CredentialLeafUpdate[],
): Promise<PublishedRoot> {
  const receipt = await submit("publication", { functionName: "publishCredentialRoot", args: [newRoot, updates] });
  return {
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    previousRoot: supersededRoot(receipt, "CredentialRootPublished"),
  };
}

export async function publishCountryRoot(
  assetId: bigint,
  newRoot: bigint,
  updates: CountryLeafUpdate[],
): Promise<PublishedRoot> {
  const receipt = await submit("publication", { functionName: "publishCountryRoot", args: [assetId, newRoot, updates] });
  return {
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    previousRoot: supersededRoot(receipt, "CountryRootPublished"),
  };
}

/// Drops a superseded root's remaining validity to zero. Without it a revoked
/// commitment keeps proving membership against the previous root for as long as
/// `rootValidityWindow` lasts, and revocation is not immediate.
export async function invalidateCredentialRoot(root: bigint): Promise<Hex> {
  const receipt = await submit("invalidation", { functionName: "invalidateCredentialRoot", args: [root] });
  return receipt.transactionHash;
}

export async function invalidateCountryRoot(assetId: bigint, root: bigint): Promise<Hex> {
  const receipt = await submit("invalidation", { functionName: "invalidateCountryRoot", args: [assetId, root] });
  return receipt.transactionHash;
}

/// The publication that made `root` current, searched from `fromBlock` on. It is how a
/// retry recognises a root this service published and never recorded -- a receipt that
/// timed out and was mined later -- instead of failing on `RootUnchanged`.
export async function findCredentialRootPublication(
  root: bigint,
  fromBlock?: bigint,
  toBlock?: bigint,
): Promise<PublishedRoot | null> {
  const to = toBlock ?? (await stateBlock());
  const logs = await read("CredentialRootPublished logs", () =>
    inBlockWindows(fromBlock ?? config.chain.registryDeploymentBlock, to, chainSettings().logBlockRange, (windowFrom, windowTo) =>
      publicClient().getContractEvents({
        address: credentialRegistryAddress,
        abi: credentialRegistryAbi,
        eventName: "CredentialRootPublished",
        args: { newRoot: root },
        fromBlock: windowFrom,
        toBlock: windowTo,
      }),
    ),
  );
  return latestPublication(logs.map((log) => ({ log, previousRoot: log.args.previousRoot ?? null })));
}

export async function findCountryRootPublication(
  assetId: bigint,
  root: bigint,
  fromBlock?: bigint,
  toBlock?: bigint,
): Promise<PublishedRoot | null> {
  const to = toBlock ?? (await stateBlock());
  const logs = await read("CountryRootPublished logs", () =>
    inBlockWindows(fromBlock ?? config.chain.registryDeploymentBlock, to, chainSettings().logBlockRange, (windowFrom, windowTo) =>
      publicClient().getContractEvents({
        address: credentialRegistryAddress,
        abi: credentialRegistryAbi,
        eventName: "CountryRootPublished",
        args: { assetId, newRoot: root },
        fromBlock: windowFrom,
        toBlock: windowTo,
      }),
    ),
  );
  return latestPublication(logs.map((log) => ({ log, previousRoot: log.args.previousRoot ?? null })));
}

function latestPublication(
  found: { log: { blockNumber: bigint | null; logIndex: number | null; transactionHash: Hex | null }; previousRoot: bigint | null }[],
): PublishedRoot | null {
  const ordered = found
    .filter(({ log }) => log.transactionHash !== null)
    .sort((a, b) =>
      byLogOrder(
        { blockNumber: a.log.blockNumber ?? 0n, logIndex: a.log.logIndex ?? 0 },
        { blockNumber: b.log.blockNumber ?? 0n, logIndex: b.log.logIndex ?? 0 },
      ),
    );
  const last = ordered.at(-1);
  if (!last) return null;
  return { txHash: last.log.transactionHash!, blockNumber: last.log.blockNumber ?? 0n, previousRoot: last.previousRoot };
}

/// Whether an address carries code, which is how a contract account gives
/// itself away. A contract account has no reproducible signature of its own --
/// ERC-1271 validates on behalf of a signer the account can change -- so a
/// secret derived from one is not regenerable and activation refuses it.
///
/// It answers for the state of the chain now: a counterfactual ERC-4337 account
/// that has not been deployed yet still reads as an EOA. That residual case is
/// in the notes.
export async function isContractAccount(address: Address): Promise<boolean> {
  const code = await read("isContractAccount", () => publicClient().getCode({ address }));
  return code !== undefined && code !== "0x";
}

export async function readCredentialRoot(options: ReadOptions = {}): Promise<bigint> {
  return read("credentialRoot", () =>
    publicClient().readContract({
      address: credentialRegistryAddress,
      abi: credentialRegistryAbi,
      functionName: "credentialRoot",
      blockNumber: options.at,
    }),
  );
}

export async function readCountryRoot(assetId: bigint, options: ReadOptions = {}): Promise<bigint> {
  return read("countryRootOf", () =>
    publicClient().readContract({
      address: credentialRegistryAddress,
      abi: credentialRegistryAbi,
      functionName: "countryRootOf",
      args: [assetId],
      blockNumber: options.at,
    }),
  );
}

export async function isCredentialRootValid(root: bigint, options: ReadOptions = {}): Promise<boolean> {
  return read("isCredentialRootValid", () =>
    publicClient().readContract({
      address: credentialRegistryAddress,
      abi: credentialRegistryAbi,
      functionName: "isCredentialRootValid",
      args: [root],
      blockNumber: options.at,
    }),
  );
}

export async function isCountryRootValid(assetId: bigint, root: bigint, options: ReadOptions = {}): Promise<boolean> {
  return read("isCountryRootValid", () =>
    publicClient().readContract({
      address: credentialRegistryAddress,
      abi: credentialRegistryAbi,
      functionName: "isCountryRootValid",
      args: [assetId, root],
      blockNumber: options.at,
    }),
  );
}

export async function readCurrentEpochEnd(options: ReadOptions = {}): Promise<bigint> {
  return read("currentEpochEnd", () =>
    publicClient().readContract({
      address: complianceAttestorAddress,
      abi: complianceAttestorAbi,
      functionName: "currentEpochEnd",
      blockNumber: options.at,
    }),
  );
}

export async function readEpochLength(options: ReadOptions = {}): Promise<bigint> {
  return read("epochLength", () =>
    publicClient().readContract({
      address: complianceAttestorAddress,
      abi: complianceAttestorAbi,
      functionName: "epochLength",
      blockNumber: options.at,
    }),
  );
}

export async function isNullifierSpent(nullifier: bigint, options: ReadOptions = {}): Promise<boolean> {
  return read("isNullifierSpent", () =>
    publicClient().readContract({
      address: complianceAttestorAddress,
      abi: complianceAttestorAbi,
      functionName: "isNullifierSpent",
      args: [nullifier],
      blockNumber: options.at,
    }),
  );
}

export async function readAttestation(assetId: bigint, subject: Address, options: ReadOptions = {}): Promise<Attestation> {
  const attestation = await read("attestationOf", () =>
    publicClient().readContract({
      address: complianceAttestorAddress,
      abi: complianceAttestorAbi,
      functionName: "attestationOf",
      args: [assetId, subject],
      blockNumber: options.at,
    }),
  );
  return { issuedAt: attestation.issuedAt, expiresAt: attestation.expiresAt, nullifier: attestation.nullifier };
}

/// Walks [from, to] in windows of at most `blockRange` blocks, because public
/// nodes cap the span of one `eth_getLogs`. A node that refuses the window anyway
/// gets it halved, down to a single block, and the smaller window is kept.
async function inBlockWindows<T>(
  from: bigint,
  to: bigint,
  blockRange: number,
  fetchWindow: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
): Promise<T[]> {
  const found: T[] = [];
  let span = BigInt(Math.max(1, blockRange));
  let start = from;
  while (start <= to) {
    const end = start + span - 1n < to ? start + span - 1n : to;
    try {
      found.push(...(await fetchWindow(start, end)));
      start = end + 1n;
    } catch (cause) {
      if (span > 1n && isRangeTooLargeError(cause)) {
        span = (end - start + 1n) / 2n || 1n;
        continue;
      }
      throw cause;
    }
  }
  return found;
}

/// The registry emits every leaf change, which is what lets the issuer throw its
/// database away and still rebuild both trees. Events come back in block and log
/// order because replay is only correct in the order the chain accepted them.
export async function fetchCredentialLeafEvents(
  fromBlock?: bigint,
  toBlock?: bigint,
  options: LogQueryOptions = {},
): Promise<CredentialLeafEvent[]> {
  const to = toBlock ?? (await stateBlock());
  const logs = await read("CredentialLeafUpdated logs", () =>
    inBlockWindows(
      fromBlock ?? config.chain.registryDeploymentBlock,
      to,
      options.blockRange ?? chainSettings().logBlockRange,
      (windowFrom, windowTo) =>
        publicClient().getContractEvents({
          address: credentialRegistryAddress,
          abi: credentialRegistryAbi,
          eventName: "CredentialLeafUpdated",
          fromBlock: windowFrom,
          toBlock: windowTo,
        }),
    ),
  );
  return logs
    .map((log) => ({
      blockNumber: log.blockNumber ?? 0n,
      logIndex: log.logIndex ?? 0,
      newRoot: log.args.newRoot ?? 0n,
      leafIndex: Number(log.args.leafIndex ?? 0n),
      commitment: log.args.commitment ?? 0n,
      inserted: log.args.inserted ?? false,
    }))
    .sort(byLogOrder);
}

export async function fetchCountryLeafEvents(
  assetId: bigint,
  fromBlock?: bigint,
  toBlock?: bigint,
  options: LogQueryOptions = {},
): Promise<CountryLeafEvent[]> {
  const to = toBlock ?? (await stateBlock());
  const logs = await read("CountryLeafUpdated logs", () =>
    inBlockWindows(
      fromBlock ?? config.chain.registryDeploymentBlock,
      to,
      options.blockRange ?? chainSettings().logBlockRange,
      (windowFrom, windowTo) =>
        publicClient().getContractEvents({
          address: credentialRegistryAddress,
          abi: credentialRegistryAbi,
          eventName: "CountryLeafUpdated",
          args: { assetId },
          fromBlock: windowFrom,
          toBlock: windowTo,
        }),
    ),
  );
  return logs
    .map((log) => ({
      blockNumber: log.blockNumber ?? 0n,
      logIndex: log.logIndex ?? 0,
      assetId: log.args.assetId ?? 0n,
      newRoot: log.args.newRoot ?? 0n,
      leafIndex: Number(log.args.leafIndex ?? 0n),
      countryCode: log.args.countryCode ?? 0,
      admitted: log.args.admitted ?? false,
    }))
    .sort(byLogOrder);
}

function byLogOrder(a: { blockNumber: bigint; logIndex: number }, b: { blockNumber: bigint; logIndex: number }): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}
