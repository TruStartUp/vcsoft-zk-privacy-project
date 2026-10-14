import type { Address } from "viem";

import { apiError } from "../../src/lib/errors.js";
import type {
  Attestation,
  CountryLeafEvent,
  CountryLeafUpdate,
  CredentialLeafEvent,
  CredentialLeafUpdate,
  LogQueryOptions,
  PublishedRoot,
  ReadOptions,
} from "../../src/services/registry.service.js";

/// Stands in for the registry and the attestor so the suite exercises the whole
/// service without a node. It keeps the state the contracts keep -- current
/// root, superseded roots, spent nullifiers, the event log -- because the
/// behaviour under test is what the service does with that state.
///
/// It also keeps the roots as they stood after every block, so a test can make
/// `latest` lag behind (`headLag`) the way a load-balanced public node does, and
/// check that nothing the service decides rests on such a read.
export interface RegistryState {
  credentialRoot: bigint;
  supersededCredentialRoots: Set<string>;
  countryRoots: Map<string, bigint>;
  supersededCountryRoots: Map<string, Set<string>>;
  spentNullifiers: Set<string>;
  attestations: Map<string, Attestation>;
  epochLength: bigint;
  currentEpochEnd: bigint;
  blockNumber: bigint;
  credentialEvents: CredentialLeafEvent[];
  countryEvents: CountryLeafEvent[];
  contractAccounts: Set<string>;
  failNextPublication: boolean;
  /// The publication is mined, and the caller is told its receipt never arrived.
  timeoutNextPublication: boolean;
  /// Invalidations that fail before reaching the chain, one per attempt.
  failingInvalidations: number;
  rootPublications: RootPublishedEvent[];
  publicationGate: Promise<void> | null;
  publicationsAtGate: number;
  headLag: bigint;
  history: RootsSnapshot[];
  readBlocks: (bigint | undefined)[];
}

export interface RootPublishedEvent {
  assetId: bigint | null;
  newRoot: bigint;
  previousRoot: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

interface RootsSnapshot {
  blockNumber: bigint;
  credentialRoot: bigint;
  supersededCredentialRoots: Set<string>;
  countryRoots: Map<string, bigint>;
  supersededCountryRoots: Map<string, Set<string>>;
}

export const state: RegistryState = freshState();

function freshState(): RegistryState {
  return {
    credentialRoot: 0n,
    supersededCredentialRoots: new Set(),
    countryRoots: new Map(),
    supersededCountryRoots: new Map(),
    spentNullifiers: new Set(),
    attestations: new Map(),
    epochLength: 2_592_000n,
    currentEpochEnd: 2_210_976_000n,
    blockNumber: 0n,
    credentialEvents: [],
    countryEvents: [],
    contractAccounts: new Set(),
    failNextPublication: false,
    timeoutNextPublication: false,
    failingInvalidations: 0,
    rootPublications: [],
    publicationGate: null,
    publicationsAtGate: 0,
    headLag: 0n,
    history: [],
    readBlocks: [],
  };
}

export function resetRegistryStub(): void {
  Object.assign(state, freshState());
}

function snapshot(): void {
  state.history.push({
    blockNumber: state.blockNumber,
    credentialRoot: state.credentialRoot,
    supersededCredentialRoots: new Set(state.supersededCredentialRoots),
    countryRoots: new Map(state.countryRoots),
    supersededCountryRoots: new Map([...state.supersededCountryRoots].map(([key, roots]) => [key, new Set(roots)])),
  });
}

/// The roots as a read at `at` would see them. Without `at` the read is `latest`
/// on a node that may be `headLag` blocks behind.
function rootsAt(options: ReadOptions = {}): Omit<RootsSnapshot, "blockNumber"> {
  state.readBlocks.push(options.at);
  const block = options.at ?? state.blockNumber - state.headLag;
  if (block >= state.blockNumber) return state;
  const seen = state.history.filter((entry) => entry.blockNumber <= block).at(-1);
  return (
    seen ?? {
      credentialRoot: 0n,
      supersededCredentialRoots: new Set(),
      countryRoots: new Map(),
      supersededCountryRoots: new Map(),
    }
  );
}

function nextBlock(): bigint {
  state.blockNumber += 1n;
  return state.blockNumber;
}

function txHash(): `0x${string}` {
  return `0x${state.blockNumber.toString(16).padStart(64, "0")}` as `0x${string}`;
}

/// The same error the real service raises when the registry reverts, decoded.
function publicationReverted(error: string, args: bigint[]) {
  return apiError.failedDependency("root_publication_reverted", "the registry reverted the new root", {
    revert: { error, args: args.map(String) },
  });
}

function receiptTimedOut() {
  state.timeoutNextPublication = false;
  return apiError.failedDependency(
    "chain_receipt_timeout",
    "the transaction was sent and no receipt arrived in time; reconcile before writing again",
    { txHash: txHash(), timeoutMs: 1 },
  );
}

function failInvalidation(): void {
  if (state.failingInvalidations > 0) {
    state.failingInvalidations -= 1;
    throw apiError.failedDependency("chain_call_failed", "invalidateCredentialRoot failed on chain", {
      reason: "connection reset",
    });
  }
}

function invalidationReverted(error: string, args: bigint[]) {
  return apiError.failedDependency("root_invalidation_reverted", "the registry refused to drop the root", {
    revert: { error, args: args.map(String) },
  });
}

export async function publishCredentialRoot(
  newRoot: bigint,
  updates: CredentialLeafUpdate[],
): Promise<PublishedRoot> {
  if (state.publicationGate) {
    state.publicationsAtGate += 1;
    await state.publicationGate;
  }
  if (state.failNextPublication) {
    state.failNextPublication = false;
    throw new Error("registry refused the root");
  }
  const previousRoot = state.credentialRoot;
  if (newRoot === previousRoot) throw publicationReverted("RootUnchanged", [newRoot]);
  const blockNumber = nextBlock();
  if (previousRoot !== 0n) state.supersededCredentialRoots.add(previousRoot.toString());
  state.supersededCredentialRoots.delete(newRoot.toString());
  state.credentialRoot = newRoot;
  for (const [index, update] of updates.entries()) {
    state.credentialEvents.push({
      blockNumber,
      logIndex: index,
      newRoot,
      leafIndex: Number(update.leafIndex),
      commitment: update.commitment,
      inserted: update.inserted,
    });
  }
  state.rootPublications.push({ assetId: null, newRoot, previousRoot, blockNumber, txHash: txHash() });
  snapshot();
  if (state.timeoutNextPublication) throw receiptTimedOut();
  return { txHash: txHash(), blockNumber, previousRoot };
}

export async function publishCountryRoot(
  assetId: bigint,
  newRoot: bigint,
  updates: CountryLeafUpdate[],
): Promise<PublishedRoot> {
  if (state.failNextPublication) {
    state.failNextPublication = false;
    throw new Error("registry refused the root");
  }
  const key = assetId.toString();
  const previousRoot = state.countryRoots.get(key) ?? 0n;
  if (newRoot === previousRoot) throw publicationReverted("RootUnchanged", [newRoot]);
  const padding = updates.find((update) => update.countryCode === 0);
  if (padding) throw publicationReverted("PaddingCountryCode", [padding.leafIndex]);
  const blockNumber = nextBlock();
  const superseded = state.supersededCountryRoots.get(key) ?? new Set<string>();
  if (previousRoot !== 0n) superseded.add(previousRoot.toString());
  superseded.delete(newRoot.toString());
  state.supersededCountryRoots.set(key, superseded);
  state.countryRoots.set(key, newRoot);
  for (const [index, update] of updates.entries()) {
    state.countryEvents.push({
      blockNumber,
      logIndex: index,
      assetId,
      newRoot,
      leafIndex: Number(update.leafIndex),
      countryCode: update.countryCode,
      admitted: update.admitted,
    });
  }
  state.rootPublications.push({ assetId, newRoot, previousRoot, blockNumber, txHash: txHash() });
  snapshot();
  if (state.timeoutNextPublication) throw receiptTimedOut();
  return { txHash: txHash(), blockNumber, previousRoot };
}

/// Executes against the true current state, as a mined transaction does.
export async function invalidateCredentialRoot(root: bigint): Promise<`0x${string}`> {
  failInvalidation();
  if (root === state.credentialRoot) throw invalidationReverted("RootIsCurrent", [root]);
  if (!state.supersededCredentialRoots.has(root.toString())) throw invalidationReverted("UnknownRoot", [root]);
  nextBlock();
  state.supersededCredentialRoots.delete(root.toString());
  snapshot();
  return txHash();
}

export async function invalidateCountryRoot(assetId: bigint, root: bigint): Promise<`0x${string}`> {
  failInvalidation();
  const key = assetId.toString();
  if (root === state.countryRoots.get(key)) throw invalidationReverted("RootIsCurrent", [root]);
  const superseded = state.supersededCountryRoots.get(key);
  if (!superseded?.has(root.toString())) throw invalidationReverted("UnknownRoot", [root]);
  nextBlock();
  superseded.delete(root.toString());
  snapshot();
  return txHash();
}

function latestPublished(assetId: bigint | null, root: bigint, fromBlock?: bigint, toBlock?: bigint): PublishedRoot | null {
  const found = state.rootPublications.filter(
    (event) =>
      event.assetId === assetId &&
      event.newRoot === root &&
      event.blockNumber >= (fromBlock ?? 0n) &&
      event.blockNumber <= (toBlock ?? state.blockNumber),
  );
  const last = found.at(-1);
  return last ? { txHash: last.txHash, blockNumber: last.blockNumber, previousRoot: last.previousRoot } : null;
}

export async function findCredentialRootPublication(root: bigint, fromBlock?: bigint, toBlock?: bigint): Promise<PublishedRoot | null> {
  return latestPublished(null, root, fromBlock, toBlock);
}

export async function findCountryRootPublication(
  assetId: bigint,
  root: bigint,
  fromBlock?: bigint,
  toBlock?: bigint,
): Promise<PublishedRoot | null> {
  return latestPublished(assetId, root, fromBlock, toBlock);
}

export async function stateBlock(): Promise<bigint> {
  return state.blockNumber;
}

export async function readCredentialRoot(options?: ReadOptions): Promise<bigint> {
  return rootsAt(options).credentialRoot;
}

export async function readCountryRoot(assetId: bigint, options?: ReadOptions): Promise<bigint> {
  return rootsAt(options).countryRoots.get(assetId.toString()) ?? 0n;
}

export async function isCredentialRootValid(root: bigint, options?: ReadOptions): Promise<boolean> {
  if (root === 0n) return false;
  const roots = rootsAt(options);
  return root === roots.credentialRoot || roots.supersededCredentialRoots.has(root.toString());
}

export async function isCountryRootValid(assetId: bigint, root: bigint, options?: ReadOptions): Promise<boolean> {
  if (root === 0n) return false;
  const roots = rootsAt(options);
  const key = assetId.toString();
  if (roots.countryRoots.get(key) === root) return true;
  return roots.supersededCountryRoots.get(key)?.has(root.toString()) ?? false;
}

export async function readCurrentEpochEnd(_options?: ReadOptions): Promise<bigint> {
  return state.currentEpochEnd;
}

export async function readEpochLength(_options?: ReadOptions): Promise<bigint> {
  return state.epochLength;
}

export async function isNullifierSpent(nullifier: bigint, _options?: ReadOptions): Promise<boolean> {
  return state.spentNullifiers.has(nullifier.toString());
}

export async function readAttestation(assetId: bigint, subject: Address, _options?: ReadOptions): Promise<Attestation> {
  return (
    state.attestations.get(`${assetId}/${subject.toLowerCase()}`) ?? {
      issuedAt: 0n,
      expiresAt: 0n,
      nullifier: 0n,
    }
  );
}

export async function fetchCredentialLeafEvents(
  fromBlock?: bigint,
  toBlock?: bigint,
  _options?: LogQueryOptions,
): Promise<CredentialLeafEvent[]> {
  return state.credentialEvents.filter(
    (event) => event.blockNumber >= (fromBlock ?? 0n) && event.blockNumber <= (toBlock ?? state.blockNumber),
  );
}

export async function fetchCountryLeafEvents(
  assetId: bigint,
  fromBlock?: bigint,
  toBlock?: bigint,
  _options?: LogQueryOptions,
): Promise<CountryLeafEvent[]> {
  return state.countryEvents.filter(
    (event) =>
      event.assetId === assetId &&
      event.blockNumber >= (fromBlock ?? 0n) &&
      event.blockNumber <= (toBlock ?? state.blockNumber),
  );
}

export async function isContractAccount(address: Address): Promise<boolean> {
  return state.contractAccounts.has(address.toLowerCase());
}
