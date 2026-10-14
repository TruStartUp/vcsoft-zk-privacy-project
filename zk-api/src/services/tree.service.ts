import { CREDENTIAL_TREE_DEPTH, JURISDICTION_TREE_DEPTH } from "../lib/field.js";
import { SparseMerkleTree, replayLeafUpdates, type LeafUpdate } from "../lib/merkle.js";
import { poseidonHash } from "../lib/poseidon.js";
import { prisma, type PrismaTransaction } from "../lib/prisma.js";
import {
  fetchCountryLeafEvents,
  fetchCredentialLeafEvents,
  readCountryRoot,
  readCredentialRoot,
  stateBlock,
} from "./registry.service.js";

export interface RebuildReport {
  source: "chain-events";
  events: number;
  leafCount: number;
  replayedRoot: string;
  onChainRoot: string;
  matchesChain: boolean;
  throughBlock: string;
}

/// `pendingRootInvalidations` names the removals whose superseded root this service
/// was asked to close and has not closed yet: the commitment, for credentials, and the
/// root, for jurisdictions.
export interface CredentialReconciliation extends RebuildReport {
  missingFromDatabase: string[];
  missingFromChain: string[];
  pendingRootInvalidations: string[];
}

export interface JurisdictionReconciliation extends RebuildReport {
  missingFromDatabase: number[];
  missingFromChain: number[];
  pendingRootInvalidations: string[];
}

/// The trees live off chain and are rebuilt, never cached to disk: at this depth
/// a full rebuild from the database is a few thousand Poseidon calls, and having
/// exactly one construction path removes the class of bug where a persisted tree
/// drifts from the rows it was built from.
export async function buildCredentialTree(client: PrismaTransaction = prisma): Promise<SparseMerkleTree> {
  const hash = await poseidonHash();
  const rows = await client.credential.findMany({
    where: { inTree: true, commitment: { not: null }, leafIndex: { not: null } },
    select: { leafIndex: true, commitment: true },
  });
  return SparseMerkleTree.from(
    CREDENTIAL_TREE_DEPTH,
    hash,
    rows.map((row) => [row.leafIndex!, BigInt(row.commitment!)] as [number, bigint]),
  );
}

export async function buildJurisdictionTree(
  assetId: string,
  client: PrismaTransaction = prisma,
): Promise<SparseMerkleTree> {
  const hash = await poseidonHash();
  const rows = await client.jurisdictionLeaf.findMany({
    where: { assetId, admitted: true },
    select: { leafIndex: true, countryCode: true },
  });
  return SparseMerkleTree.from(
    JURISDICTION_TREE_DEPTH,
    hash,
    rows.map((row) => [row.leafIndex, BigInt(row.countryCode)] as [number, bigint]),
  );
}

/// A registry that never published holds root 0, not the digest of an empty tree.
function replayMatches(tree: SparseMerkleTree, events: number, onChainRoot: bigint): boolean {
  return tree.root() === onChainRoot || (events === 0 && onChainRoot === 0n);
}

/// Rebuilds the credential tree from the registry's own log and says whether the
/// result matches what the registry holds. This is the recovery path: with the
/// database gone, the chain still carries every leaf change in order. The events
/// and the root are read through the same block, so the comparison is between
/// two views of one state.
export async function rebuildCredentialTreeFromChain(): Promise<{
  tree: SparseMerkleTree;
  report: RebuildReport;
}> {
  const hash = await poseidonHash();
  const throughBlock = await stateBlock();
  const events = await fetchCredentialLeafEvents(undefined, throughBlock);

  const updates: LeafUpdate[] = events.map((event) => ({
    leafIndex: event.leafIndex,
    value: event.commitment,
    present: event.inserted,
  }));

  const tree = replayLeafUpdates(CREDENTIAL_TREE_DEPTH, hash, updates);
  const onChainRoot = await readCredentialRoot({ at: throughBlock });

  return {
    tree,
    report: {
      source: "chain-events",
      events: events.length,
      leafCount: tree.leafCount,
      replayedRoot: tree.root().toString(),
      onChainRoot: onChainRoot.toString(),
      matchesChain: replayMatches(tree, events.length, onChainRoot),
      throughBlock: throughBlock.toString(),
    },
  };
}

export async function rebuildJurisdictionTreeFromChain(assetId: string): Promise<{
  tree: SparseMerkleTree;
  report: RebuildReport;
}> {
  const hash = await poseidonHash();
  const throughBlock = await stateBlock();
  const events = await fetchCountryLeafEvents(BigInt(assetId), undefined, throughBlock);

  const updates: LeafUpdate[] = events.map((event) => ({
    leafIndex: event.leafIndex,
    value: BigInt(event.countryCode),
    present: event.admitted,
  }));

  const tree = replayLeafUpdates(JURISDICTION_TREE_DEPTH, hash, updates);
  const onChainRoot = await readCountryRoot(BigInt(assetId), { at: throughBlock });

  return {
    tree,
    report: {
      source: "chain-events",
      events: events.length,
      leafCount: tree.leafCount,
      replayedRoot: tree.root().toString(),
      onChainRoot: onChainRoot.toString(),
      matchesChain: replayMatches(tree, events.length, onChainRoot),
      throughBlock: throughBlock.toString(),
    },
  };
}

/// Names the disagreements instead of silently repairing them. A commitment the
/// chain carries and the database does not is a lost envelope -- the holder can
/// still prove, and nobody can open their identity -- and that is an incident,
/// not something to paper over.
export async function reconcileCredentialTree(): Promise<CredentialReconciliation> {
  const { tree, report } = await rebuildCredentialTreeFromChain();

  const rows = await prisma.credential.findMany({
    where: { inTree: true, commitment: { not: null }, leafIndex: { not: null } },
    select: { leafIndex: true, commitment: true },
  });

  const onChain = new Map<number, bigint>(tree.leaves());
  const inDatabase = new Map(rows.map((row) => [row.leafIndex!, BigInt(row.commitment!)]));

  const missingFromDatabase: string[] = [];
  for (const [leafIndex, commitment] of onChain) {
    if (inDatabase.get(leafIndex) !== commitment) missingFromDatabase.push(commitment.toString());
  }

  const missingFromChain: string[] = [];
  for (const [leafIndex, commitment] of inDatabase) {
    if (onChain.get(leafIndex) !== commitment) missingFromChain.push(commitment.toString());
  }

  const pending = await prisma.rootPublication.findMany({
    where: { kind: "CREDENTIAL", invalidationRequested: true, invalidatedAt: null },
    orderBy: { publishedAt: "asc" },
    select: { commitment: true, previousRoot: true },
  });
  const pendingRootInvalidations = pending.map((row) => row.commitment ?? row.previousRoot ?? "0");

  return { ...report, missingFromDatabase, missingFromChain, pendingRootInvalidations };
}

/// The jurisdiction tree of one asset against the chain and against the database, in
/// the same terms as the credential tree: country codes instead of commitments.
export async function reconcileJurisdictionTree(assetId: string): Promise<JurisdictionReconciliation> {
  const { tree, report } = await rebuildJurisdictionTreeFromChain(assetId);

  const rows = await prisma.jurisdictionLeaf.findMany({
    where: { assetId, admitted: true },
    select: { leafIndex: true, countryCode: true },
  });
  const onChain = new Map<number, bigint>(tree.leaves());
  const inDatabase = new Map(rows.map((row) => [row.leafIndex, BigInt(row.countryCode)]));

  const missingFromDatabase: number[] = [];
  for (const [leafIndex, code] of onChain) {
    if (inDatabase.get(leafIndex) !== code) missingFromDatabase.push(Number(code));
  }
  const missingFromChain: number[] = [];
  for (const [leafIndex, code] of inDatabase) {
    if (onChain.get(leafIndex) !== code) missingFromChain.push(Number(code));
  }

  const pending = await prisma.rootPublication.findMany({
    where: { kind: "JURISDICTION", assetId, invalidationRequested: true, invalidatedAt: null },
    orderBy: { publishedAt: "asc" },
    select: { previousRoot: true },
  });

  return {
    ...report,
    missingFromDatabase,
    missingFromChain,
    pendingRootInvalidations: pending.map((row) => row.previousRoot ?? "0"),
  };
}

/// Everything in a reconciliation that is not a healthy state, in words an operator
/// can act on. Empty means the chain, the database and the closures all agree.
export function reconciliationProblems(
  report: CredentialReconciliation | JurisdictionReconciliation,
  label: string,
): string[] {
  const problems: string[] = [];
  if (!report.matchesChain) problems.push(`${label}: the replayed root does not match the on-chain root`);
  if (report.missingFromDatabase.length > 0) {
    problems.push(`${label}: ${report.missingFromDatabase.length} on chain and missing from the database`);
  }
  if (report.missingFromChain.length > 0) {
    problems.push(`${label}: ${report.missingFromChain.length} in the database and missing from the chain`);
  }
  if (report.pendingRootInvalidations.length > 0) {
    problems.push(`${label}: ${report.pendingRootInvalidations.length} superseded root window(s) still to close`);
  }
  return problems;
}

export interface FullReconciliation {
  credentialTree: CredentialReconciliation;
  jurisdictionTrees: { assetId: string; jurisdictionTree: JurisdictionReconciliation }[];
  problems: string[];
}

export async function reconcileIssuerState(assetIds: string[]): Promise<FullReconciliation> {
  const credentialTree = await reconcileCredentialTree();
  const problems = reconciliationProblems(credentialTree, "credentialTree");
  const jurisdictionTrees: FullReconciliation["jurisdictionTrees"] = [];
  for (const assetId of assetIds) {
    const jurisdictionTree = await reconcileJurisdictionTree(assetId);
    jurisdictionTrees.push({ assetId, jurisdictionTree });
    problems.push(...reconciliationProblems(jurisdictionTree, `jurisdictionTree ${assetId}`));
  }
  return { credentialTree, jurisdictionTrees, problems };
}
