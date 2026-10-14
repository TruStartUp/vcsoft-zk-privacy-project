import { randomUUID } from "node:crypto";

import { Prisma, type Credential, type CredentialStatus, type RootPublication } from "@prisma/client";
import { getAddress, isAddress, type Address, type Hex } from "viem";

import { config } from "../config/index.js";
import { chainSettings } from "../lib/chain.js";
import { apiError, isApiError } from "../lib/errors.js";
import { CREDENTIAL_TREE_DEPTH, JURISDICTION_TREE_DEPTH, isCountryCode, isFieldElement } from "../lib/field.js";
import {
  holderTypedDataDomain,
  holderTypedDataTypes,
  recoverActivationSigner,
  secretDerivationTypedData,
} from "../lib/holder-secret.js";
import { logger } from "../lib/logger.js";
import type { MerkleOpening } from "../lib/merkle.js";
import { prisma, type PrismaTransaction } from "../lib/prisma.js";
import { deriveCommitment, subjectReference } from "./credential-material.service.js";
import { sealIdentity, toEnvelopeColumns, type HolderIdentity } from "./disclosure.service.js";
import * as registry from "./registry.service.js";
import { buildCredentialTree, buildJurisdictionTree } from "./tree.service.js";

/// The result of the bank's identity check. It is an input to this service, not
/// something it performs: the issuer trusts the verdict and turns it into a
/// credential.
///
/// `holderAddress` is the wallet the check was performed against. It is what
/// activation is verified against later, and it is the reason a stranger who
/// learns a pending credential's identifier cannot claim it.
export interface IdentityVerificationResult {
  kycSubjectId: string;
  approved: boolean;
  countryCode: number;
  expiresAt: Date;
  verificationRef: string;
  holderAddress: string;
  identity: HolderIdentity;
}

/// What the holder's application gets back from the first step: an identifier to
/// activate against, and the two messages its wallet will be asked to sign.
export interface PendingCredential {
  credentialId: string;
  status: Extract<CredentialStatus, "PENDING">;
  countryCode: number;
  expiresAt: string;
  holderAddress: Address;
  activation: {
    secretDerivation: ReturnType<typeof secretDerivationTypedData>;
    possession: {
      domain: ReturnType<typeof holderTypedDataDomain>;
      types: { CredentialActivation: typeof holderTypedDataTypes.CredentialActivation };
      primaryType: "CredentialActivation";
    };
  };
}

export interface IssuedCredential {
  credentialId: string;
  commitment: string;
  leafIndex: number;
  countryCode: number;
  expiresAt: string;
  status: CredentialStatus;
  credentialRoot: string;
  txHash: string;
}

export interface ActivationInput {
  secretHash: string;
  signature: Hex;
}

const CREDENTIAL_TREE_LOCK = 8_140_101n;
const jurisdictionTreeLock = (assetId: string): bigint => 8_140_200n + (BigInt(assetId) % 100_000n);

/// A credential that still stands in the way of a second one for the same
/// person. A revoked credential does not: that is what lets an investor who lost
/// their wallet be verified again and issued a new one.
const LIVE_STATUSES = ["PENDING", "ACTIVE", "SUSPENDED"] as const satisfies readonly CredentialStatus[];

const writeQueues = new Map<bigint, { tail: Promise<unknown>; queued: number }>();

/// A tree change: one at a time per tree in this process, then inside a transaction
/// that takes the tree's advisory lock, which orders changes across processes.
///
/// The in-process queue is what keeps the pool alive. A change waiting on the advisory
/// lock holds a pooled connection for as long as the changes ahead of it take, and
/// enough of them starve every other query of the service. Here they wait in memory,
/// and past `ISSUER_WRITE_QUEUE_LIMIT` a change is refused before it touches anything.
/// The transaction may wait for two receipts, so it outlives both.
async function treeTransaction<T>(lockKey: bigint, body: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
  const queue = writeQueues.get(lockKey) ?? { tail: Promise.resolve(), queued: 0 };
  writeQueues.set(lockKey, queue);
  if (queue.queued >= config.issuer.writeQueueLimit) {
    throw apiError.serviceUnavailable("service_busy", "too many tree changes are already waiting; retry after the interval given", 5, {
      reason: "issuer_write_queue_full",
      queued: queue.queued,
    });
  }
  queue.queued += 1;
  const write = () =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${lockKey})`);
        return body(tx);
      },
      { timeout: 2 * chainSettings().receiptTimeoutMs + 60_000, maxWait: 30_000 },
    );
  const run = queue.tail.then(write, write);
  queue.tail = run
    .catch(() => undefined)
    .finally(() => {
      queue.queued -= 1;
    });
  return run;
}

interface RecordedRoot {
  root: bigint;
  blockNumber: bigint | null;
}

async function lastPublication(
  tx: PrismaTransaction,
  kind: "CREDENTIAL" | "JURISDICTION",
  assetId: string | null = null,
): Promise<RecordedRoot | null> {
  const last = await tx.rootPublication.findFirst({
    where: { kind, assetId },
    orderBy: [{ blockNumber: { sort: "desc", nulls: "last" } }, { publishedAt: "desc" }],
    select: { root: true, blockNumber: true },
  });
  return last ? { root: BigInt(last.root), blockNumber: last.blockNumber } : null;
}

interface RootChain {
  publish: () => Promise<registry.PublishedRoot>;
  current: (at: bigint) => Promise<bigint>;
  find: (fromBlock: bigint | undefined, toBlock: bigint) => Promise<registry.PublishedRoot | null>;
}

function errorCode(error: unknown): string | undefined {
  return isApiError(error) ? (error.output.payload as { code?: string }).code : undefined;
}

/// Publishes, or adopts a publication this service already made and never recorded.
///
/// A receipt that timed out and was mined later, or a failure after a confirmed
/// publication, leaves the registry holding a root the database rolled back. Repeating
/// the change computes that same root and the registry refuses it as unchanged; since it
/// is exactly the root this change wants, its publication is recorded instead.
async function publishOrAdopt(
  tx: PrismaTransaction,
  newRoot: bigint,
  known: RecordedRoot | null,
  chain: RootChain,
  context: Record<string, unknown>,
): Promise<registry.PublishedRoot> {
  try {
    return await chain.publish();
  } catch (cause) {
    if (errorCode(cause) !== "root_publication_reverted") throw cause;
    const at = await registry.stateBlock();
    if ((await chain.current(at)) !== newRoot) throw cause;
    const found = await chain.find(known?.blockNumber ?? undefined, at);
    if (!found) throw cause;
    if (await tx.rootPublication.findUnique({ where: { txHash: found.txHash }, select: { id: true } })) throw cause;
    logger.warn(
      { ...context, txHash: found.txHash, root: newRoot.toString() },
      "the registry already holds this root from a publication this service had not recorded; recording it",
    );
    return found;
  }
}

async function rootStillValid(root: bigint, assetId: bigint | null): Promise<boolean> {
  try {
    const at = { at: await registry.stateBlock() };
    return assetId === null ? await registry.isCredentialRootValid(root, at) : await registry.isCountryRootValid(assetId, root, at);
  } catch {
    return true;
  }
}

interface Closure {
  publication: RootPublication;
  failure: unknown;
}

/// Closes the window of the root a publication superseded. The publication is recorded
/// already and stays so whatever happens here: a failure leaves the closure pending, and
/// repeating the change retries it. A root that no longer validates -- an earlier attempt
/// mined after all, or a window that ran out -- has nothing left to close.
async function closeSupersededWindow(tx: PrismaTransaction, publication: RootPublication): Promise<Closure> {
  const root = BigInt(publication.previousRoot ?? "0");
  const assetId = publication.assetId === null ? null : BigInt(publication.assetId);
  let invalidationTxHash: string | null = null;
  try {
    invalidationTxHash =
      assetId === null ? await registry.invalidateCredentialRoot(root) : await registry.invalidateCountryRoot(assetId, root);
  } catch (cause) {
    if (await rootStillValid(root, assetId)) {
      logger.warn(
        { txHash: publication.txHash, root: root.toString(), code: errorCode(cause) },
        "the superseded root's window could not be closed; the closure is pending",
      );
      return { publication, failure: cause };
    }
  }
  const closed = await tx.rootPublication.update({
    where: { id: publication.id },
    data: { invalidatedAt: new Date(), invalidationTxHash },
  });
  return { publication: closed, failure: null };
}

function closureIsPending(publication: RootPublication | null): publication is RootPublication {
  return publication !== null && publication.invalidationRequested && publication.invalidatedAt === null;
}

async function settleClosure(tx: PrismaTransaction, publication: RootPublication): Promise<Closure> {
  return closureIsPending(publication) ? closeSupersededWindow(tx, publication) : { publication, failure: null };
}

/// The change is on chain and in the database; only the window closure failed.
function closurePending(failure: unknown, details: object) {
  const cause = isApiError(failure)
    ? { code: errorCode(failure), details: (failure.output.payload as { details?: unknown }).details }
    : { code: "internal_error" };
  return apiError.failedDependency(
    "root_invalidation_pending",
    "the change is published, but the superseded root's window is still open; repeat the same request to close it",
    { ...details, cause },
  );
}

async function publishCredentialTree(
  tx: PrismaTransaction,
  commitment: string,
  update: registry.CredentialLeafUpdate,
  closeRootWindow: boolean,
): Promise<RootPublication> {
  const tree = await buildCredentialTree(tx);
  const known = await lastPublication(tx, "CREDENTIAL");
  const newRoot = tree.root();

  const published = await publishOrAdopt(
    tx,
    newRoot,
    known,
    {
      publish: () => registry.publishCredentialRoot(newRoot, [update]),
      current: (at) => registry.readCredentialRoot({ at }),
      find: (fromBlock, toBlock) => registry.findCredentialRootPublication(newRoot, fromBlock, toBlock),
    },
    { commitment },
  );
  const previousRoot = supersededRoot(published, known?.root ?? null, { commitment });

  return tx.rootPublication.create({
    data: {
      kind: "CREDENTIAL",
      commitment,
      root: newRoot.toString(),
      previousRoot: previousRoot.toString(),
      leafCount: tree.leafCount,
      txHash: published.txHash,
      blockNumber: published.blockNumber,
      invalidationRequested: closeRootWindow && previousRoot !== 0n,
    },
  });
}

/// The root a publication replaced, as its own receipt reports it: never a read of
/// `latest`, which a lagging node can answer from before the previous publication.
function supersededRoot(published: registry.PublishedRoot, known: bigint | null, context: Record<string, unknown>): bigint {
  if (published.previousRoot === null) {
    logger.warn({ ...context, txHash: published.txHash }, "publication receipt carries no previous root; using the recorded one");
    return known ?? 0n;
  }
  if (known !== null && known !== published.previousRoot) {
    logger.warn(
      { ...context, txHash: published.txHash, recordedRoot: known.toString(), replacedRoot: published.previousRoot.toString() },
      "the registry replaced a root this service had not recorded as current; reconcile",
    );
  }
  return published.previousRoot;
}

function uniqueViolation(error: unknown, target: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    JSON.stringify(error.meta?.target ?? "").includes(target)
  );
}

function requireHolderAddress(value: string): Address {
  if (!isAddress(value)) {
    throw apiError.badRequest("holder_address_invalid", "the holder address is not an EVM address", {
      holderAddress: value,
    });
  }
  return getAddress(value);
}

/// Step one of issuance: the bank's verdict becomes a credential that has no
/// commitment yet.
///
/// The issuer cannot build the leaf here, and that is the point of the whole
/// change: `commitment = Poseidon(secretHash, country, expiry)` needs a value
/// only the holder can produce. What the issuer does fix is everything the
/// holder is not allowed to choose -- the jurisdiction, the expiry, and the
/// wallet that passed the check.
export async function registerVerification(verification: IdentityVerificationResult): Promise<PendingCredential> {
  if (!verification.approved) {
    throw apiError.unprocessable("verification_not_approved", "the identity verification was not approved");
  }
  if (!isCountryCode(verification.countryCode)) {
    throw apiError.badRequest("country_code_out_of_range", "a country code is in [1, 65536)", {
      countryCode: verification.countryCode,
    });
  }
  if (verification.expiresAt.getTime() <= Date.now()) {
    throw apiError.badRequest("expiry_in_the_past", "the verification has already expired", {
      expiresAt: verification.expiresAt.toISOString(),
    });
  }

  const holderAddress = requireHolderAddress(verification.holderAddress);
  const subjectRef = subjectReference(verification.kycSubjectId);

  const live = await prisma.credential.findFirst({
    where: { subjectRef, status: { in: [...LIVE_STATUSES] } },
    select: { id: true, status: true, commitment: true },
  });
  if (live) {
    throw apiError.conflict("credential_already_issued", "this subject already holds a live credential", {
      credentialId: live.id,
      commitment: live.commitment,
      status: live.status,
    });
  }

  const credentialId = randomUUID();
  const envelope = sealIdentity(verification.identity, credentialId);

  try {
    const credential = await prisma.credential.create({
      data: {
        id: credentialId,
        subjectRef,
        holderAddress: holderAddress.toLowerCase(),
        countryCode: verification.countryCode,
        expiresAt: verification.expiresAt,
        status: "PENDING",
        inTree: false,
        verificationRef: verification.verificationRef,
        envelope: { create: toEnvelopeColumns(envelope) },
      },
    });

    return {
      credentialId: credential.id,
      status: "PENDING",
      countryCode: credential.countryCode,
      expiresAt: credential.expiresAt.toISOString(),
      holderAddress,
      activation: {
        secretDerivation: secretDerivationTypedData(),
        possession: {
          domain: holderTypedDataDomain(),
          types: { CredentialActivation: holderTypedDataTypes.CredentialActivation },
          primaryType: "CredentialActivation",
        },
      },
    };
  } catch (cause) {
    if (uniqueViolation(cause, "subjectRef")) {
      throw apiError.conflict("credential_already_issued", "this subject already holds a live credential");
    }
    throw cause;
  }
}

function requireSecretHash(value: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw apiError.badRequest("secret_hash_invalid", "the secret hash is not an integer", { secretHash: value });
  }
  if (parsed === 0n || !isFieldElement(parsed)) {
    throw apiError.badRequest("secret_hash_invalid", "the secret hash is not a non-zero BN254 field element");
  }
  return parsed;
}

/// Step two: the holder hands over `Poseidon(secret)` and proves the wallet that
/// passed the identity check is the one handing it over.
///
/// The proof is a signature over a *different* message from the one the secret
/// comes from. If activation reused the derivation signature, the issuer would
/// receive the very thing the design exists to keep from it. So the holder signs
/// `CredentialActivation(credentialId, secretHash)`, which reveals nothing about
/// the secret and cannot be replayed onto another pending credential.
///
/// Without it, two attacks stay open: the issuer could substitute a `secretHash`
/// of its own and the resulting commitment would be indistinguishable from a
/// legitimate one, and anyone who learned a pending credential's identifier
/// could get in first with theirs.
export async function activateCredential(
  credentialId: string,
  activation: ActivationInput,
): Promise<IssuedCredential> {
  const credential = await prisma.credential.findUnique({ where: { id: credentialId } });
  if (!credential) throw apiError.notFound("credential_not_found", "no pending credential with that identifier");
  if (credential.status !== "PENDING") {
    throw apiError.conflict("credential_not_pending", "this credential is not waiting for activation", {
      status: credential.status,
    });
  }
  if (credential.expiresAt.getTime() <= Date.now()) {
    throw apiError.conflict("credential_expired", "the verification behind this credential has expired", {
      expiresAt: credential.expiresAt.toISOString(),
    });
  }

  const secretHash = requireSecretHash(activation.secretHash);
  const holderAddress = getAddress(credential.holderAddress);

  // Checked before the signature so the refusal names the real problem: a
  // contract account cannot produce a signature that recovers to itself, and
  // "signature mismatch" would send the integrator looking in the wrong place.
  if (await registry.isContractAccount(holderAddress)) {
    throw apiError.unprocessable(
      "holder_is_contract_account",
      "a secret derived from a contract account is not reproducible; activate from an externally owned account",
      { holderAddress },
    );
  }

  let signer: Address;
  try {
    signer = await recoverActivationSigner(credentialId, secretHash.toString(), activation.signature);
  } catch (cause) {
    throw apiError.badRequest("activation_signature_malformed", "the activation signature could not be read", {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (signer.toLowerCase() !== holderAddress.toLowerCase()) {
    throw apiError.forbidden("activation_signature_mismatch", "the activation was not signed by the holder's wallet", {
      expected: holderAddress,
      recovered: signer,
    });
  }

  // After the signature, never before: answering "that hash is taken" to a caller
  // who has not proved the wallet would turn this route into an oracle over which
  // hashes exist. Named explicitly rather than left to the unique index, because
  // one wallet behind two KYC identifiers is a different story from two
  // credentials landing on one commitment.
  const sameSecret = await prisma.credential.findUnique({
    where: { secretHash: secretHash.toString() },
    select: { id: true },
  });
  if (sameSecret) {
    throw apiError.conflict("secret_hash_already_used", "another credential already stands behind that wallet secret");
  }

  const commitment = (
    await deriveCommitment(secretHash, credential.countryCode, BigInt(Math.floor(credential.expiresAt.getTime() / 1000)))
  ).toString();

  try {
    return await treeTransaction(
      CREDENTIAL_TREE_LOCK,
      async (tx) => {
        const current = await tx.credential.findUniqueOrThrow({ where: { id: credentialId } });
        if (current.status !== "PENDING") {
          throw apiError.conflict("credential_not_pending", "this credential is not waiting for activation", {
            status: current.status,
          });
        }

        // Only rows that ever took a position count: a credential still awaiting
        // activation has none, and NULLs sort first on a descending order.
        const highest = await tx.credential.findFirst({
          where: { leafIndex: { not: null } },
          orderBy: { leafIndex: "desc" },
          select: { leafIndex: true },
        });
        const leafIndex = (highest?.leafIndex ?? -1) + 1;
        if (leafIndex >= 2 ** CREDENTIAL_TREE_DEPTH) {
          throw apiError.conflict("credential_tree_full", "the credential tree has no free position", {
            capacity: 2 ** CREDENTIAL_TREE_DEPTH,
          });
        }

        const activated = await tx.credential.update({
          where: { id: credentialId },
          data: {
            commitment,
            secretHash: secretHash.toString(),
            leafIndex,
            status: "ACTIVE",
            inTree: true,
            activatedAt: new Date(),
          },
        });

        const publication = await publishCredentialTree(
          tx,
          commitment,
          { leafIndex: BigInt(leafIndex), commitment: BigInt(commitment), inserted: true },
          false,
        );

        return {
          credentialId,
          commitment,
          leafIndex,
          countryCode: activated.countryCode,
          expiresAt: activated.expiresAt.toISOString(),
          status: activated.status,
          credentialRoot: publication.root,
          txHash: publication.txHash,
        };
      },
    );
  } catch (cause) {
    if (uniqueViolation(cause, "secretHash")) {
      throw apiError.conflict("secret_hash_already_used", "another credential already stands behind that wallet secret");
    }
    if (uniqueViolation(cause, "commitment")) {
      throw apiError.conflict("commitment_already_issued", "a credential with that commitment already exists");
    }
    throw cause;
  }
}

export interface CancelledCredential {
  credentialId: string;
  status: Extract<CredentialStatus, "REVOKED">;
}

/// Retires a credential that was never activated. Nothing was ever published for
/// it, so there is no root to move and no window to close -- but the row was
/// holding the subject's one live slot, and an abandoned enrolment must not lock
/// a person out for good.
export async function cancelPendingCredential(credentialId: string): Promise<CancelledCredential> {
  const credential = await prisma.credential.findUnique({ where: { id: credentialId } });
  if (!credential) throw apiError.notFound("credential_not_found", "no credential with that identifier");
  if (credential.status !== "PENDING") {
    throw apiError.conflict("credential_not_pending", "only a credential awaiting activation can be cancelled", {
      status: credential.status,
    });
  }

  await prisma.credential.update({
    where: { id: credentialId },
    data: { status: "REVOKED", revokedAt: new Date() },
  });

  return { credentialId, status: "REVOKED" };
}

export interface TreeChange {
  commitment: string;
  status: CredentialStatus;
  previousRoot: string;
  credentialRoot: string;
  txHash: string | null;
  previousRootInvalidated: boolean;
}

function treeChangeOf(commitment: string, status: CredentialStatus, publication: RootPublication): TreeChange {
  return {
    commitment,
    status,
    previousRoot: publication.previousRoot ?? "0",
    credentialRoot: publication.root,
    txHash: publication.txHash,
    previousRootInvalidated: publication.invalidatedAt !== null,
  };
}

interface SettledChange {
  change: TreeChange;
  failure: unknown;
}

async function settled<T extends { failure: unknown }>(result: Promise<T>, details: (value: T) => object): Promise<T> {
  const value = await result;
  if (value.failure) throw closurePending(value.failure, details(value));
  return value;
}

/// A credential already out of the tree. Repeating the removal that took it out
/// finishes a window closure left pending. Revoking a suspended one retires it for
/// good without publishing anything, expired or not: its leaf is already gone, and
/// without this a suspended credential that ran out would hold its subject's slot
/// forever.
async function changeOutOfTree(
  tx: PrismaTransaction,
  credential: Credential & { commitment: string },
  status: Extract<CredentialStatus, "REVOKED" | "SUSPENDED">,
  closeRootWindow: boolean,
): Promise<SettledChange> {
  const retiring = status === "REVOKED" && credential.status === "SUSPENDED";
  const removal = await tx.rootPublication.findFirst({
    where: { kind: "CREDENTIAL", commitment: credential.commitment },
    orderBy: [{ blockNumber: { sort: "desc", nulls: "last" } }, { publishedAt: "desc" }],
  });
  const finishing = credential.status === status && closeRootWindow && closureIsPending(removal);
  if (!retiring && !finishing) {
    throw apiError.conflict("credential_not_in_tree", "this credential is already out of the registry", {
      status: credential.status,
    });
  }

  if (retiring) {
    await tx.credential.update({ where: { id: credential.id }, data: { status: "REVOKED", revokedAt: new Date() } });
  }
  if (!removal) {
    const known = await lastPublication(tx, "CREDENTIAL");
    const root = (known?.root ?? 0n).toString();
    return {
      change: { commitment: credential.commitment, status, previousRoot: root, credentialRoot: root, txHash: null, previousRootInvalidated: false },
      failure: null,
    };
  }
  const closure = closeRootWindow ? await settleClosure(tx, removal) : { publication: removal, failure: null };
  return { change: treeChangeOf(credential.commitment, status, closure.publication), failure: closure.failure };
}

async function removeFromTree(
  commitment: string,
  status: Extract<CredentialStatus, "REVOKED" | "SUSPENDED">,
  closeRootWindow: boolean,
): Promise<TreeChange> {
  const { change } = await settled(
    treeTransaction(CREDENTIAL_TREE_LOCK, async (tx): Promise<SettledChange> => {
      const credential = await tx.credential.findUnique({ where: { commitment } });
      if (!credential) throw apiError.notFound("credential_not_found", "no credential holds that commitment");
      if (!credential.inTree || credential.leafIndex === null) {
        return changeOutOfTree(tx, { ...credential, commitment }, status, closeRootWindow);
      }

      await tx.credential.update({
        where: { commitment },
        data: {
          status,
          inTree: false,
          revokedAt: status === "REVOKED" ? new Date() : credential.revokedAt,
          suspendedAt: status === "SUSPENDED" ? new Date() : credential.suspendedAt,
        },
      });

      const publication = await publishCredentialTree(
        tx,
        commitment,
        { leafIndex: BigInt(credential.leafIndex), commitment: BigInt(commitment), inserted: false },
        closeRootWindow,
      );
      const closure = await settleClosure(tx, publication);
      return { change: treeChangeOf(commitment, status, closure.publication), failure: closure.failure };
    }),
    (value) => value.change,
  );
  return change;
}

/// Revocation is a leaf removal: the commitment stops proving membership, and no
/// other investor has to be reissued.
///
/// Removing the leaf alone is not immediate, though. The superseded root stays
/// acceptable for `rootValidityWindow`, and against it the revoked commitment
/// still proves membership. `closeRootWindow` drops that window to zero, which
/// is what the delivery record means by immediate effect.
///
/// The cost is real and is why it is a parameter: invalidating the previous root
/// also refuses proofs other holders built against it in the last minutes. They
/// lose nothing but have to fetch their opening again and re-prove.
export async function revokeCredential(commitment: string, closeRootWindow = true): Promise<TreeChange> {
  return removeFromTree(commitment, "REVOKED", closeRootWindow);
}

export async function suspendCredential(commitment: string, closeRootWindow = true): Promise<TreeChange> {
  return removeFromTree(commitment, "SUSPENDED", closeRootWindow);
}

export async function reinstateCredential(commitment: string): Promise<TreeChange> {
  return treeTransaction(
    CREDENTIAL_TREE_LOCK,
    async (tx) => {
      const credential = await tx.credential.findUnique({ where: { commitment } });
      if (!credential) throw apiError.notFound("credential_not_found", "no credential holds that commitment");
      if (credential.status !== "SUSPENDED" || credential.leafIndex === null) {
        throw apiError.conflict("credential_not_suspended", "only a suspended credential can be reinstated", {
          status: credential.status,
        });
      }
      if (credential.expiresAt.getTime() <= Date.now()) {
        throw apiError.conflict("credential_expired", "an expired credential cannot be reinstated", {
          expiresAt: credential.expiresAt.toISOString(),
        });
      }

      await tx.credential.update({
        where: { commitment },
        data: { status: "ACTIVE", inTree: true, suspendedAt: null },
      });
      // The leaf is back: closing the window of a root that held it no longer matters.
      await tx.rootPublication.updateMany({
        where: { kind: "CREDENTIAL", commitment, invalidationRequested: true, invalidatedAt: null },
        data: { invalidationRequested: false },
      });

      const publication = await publishCredentialTree(
        tx,
        commitment,
        { leafIndex: BigInt(credential.leafIndex), commitment: BigInt(commitment), inserted: true },
        false,
      );
      return treeChangeOf(commitment, "ACTIVE", publication);
    },
  );
}

export interface JurisdictionUpdate {
  assetId: string;
  admitted: number[];
  countryRoot: string;
  txHash: string;
  leafCount: number;
  previousRootInvalidated: boolean;
}

/// Replaces the admitted set of an asset. Leaf positions are stable across
/// updates so a country that stays admitted keeps its opening, and only the
/// codes that actually changed are emitted.
///
/// Withdrawing a country closes the superseded root's window by default, for the
/// same reason a revocation does: until it runs out, a holder from the withdrawn
/// country still proves against the previous root. Adding countries closes nothing.
/// The same set sent again finishes a closure left pending.
export async function setAdmittedJurisdictions(
  assetId: string,
  admitted: number[],
  closeRootWindow = true,
): Promise<JurisdictionUpdate> {
  const unique = [...new Set(admitted)];
  for (const code of unique) {
    if (!isCountryCode(code)) {
      throw apiError.badRequest("country_code_out_of_range", "a country code is in [1, 65536)", { countryCode: code });
    }
  }
  if (unique.length > 2 ** JURISDICTION_TREE_DEPTH) {
    throw apiError.badRequest("jurisdiction_tree_full", "more jurisdictions than the tree admits", {
      capacity: 2 ** JURISDICTION_TREE_DEPTH,
    });
  }

  const { update } = await settled(
    treeTransaction(jurisdictionTreeLock(assetId), async (tx) => {
      const rootBefore = (await buildJurisdictionTree(assetId, tx)).root();
      const existing = await tx.jurisdictionLeaf.findMany({ where: { assetId } });
      const byCode = new Map(existing.map((leaf) => [leaf.countryCode, leaf]));
      const takenIndices = new Set(existing.map((leaf) => leaf.leafIndex));
      const target = new Set(unique);

      const updates: registry.CountryLeafUpdate[] = [];

      for (const leaf of existing) {
        if (!target.has(leaf.countryCode) && leaf.admitted) {
          await tx.jurisdictionLeaf.update({ where: { id: leaf.id }, data: { admitted: false } });
          updates.push({ leafIndex: BigInt(leaf.leafIndex), countryCode: leaf.countryCode, admitted: false });
        }
      }

      let nextIndex = 0;
      for (const code of unique) {
        const leaf = byCode.get(code);
        if (leaf) {
          if (!leaf.admitted) {
            await tx.jurisdictionLeaf.update({ where: { id: leaf.id }, data: { admitted: true } });
            updates.push({ leafIndex: BigInt(leaf.leafIndex), countryCode: code, admitted: true });
          }
          continue;
        }
        while (takenIndices.has(nextIndex)) nextIndex += 1;
        takenIndices.add(nextIndex);
        await tx.jurisdictionLeaf.create({
          data: { assetId, leafIndex: nextIndex, countryCode: code, admitted: true },
        });
        updates.push({ leafIndex: BigInt(nextIndex), countryCode: code, admitted: true });
      }

      const tree = await buildJurisdictionTree(assetId, tx);
      const newRoot = tree.root();
      if (newRoot === rootBefore) {
        const pending = closeRootWindow
          ? await tx.rootPublication.findFirst({
              where: { kind: "JURISDICTION", assetId, invalidationRequested: true, invalidatedAt: null },
              orderBy: { publishedAt: "desc" },
            })
          : null;
        if (!pending) {
          throw apiError.conflict("jurisdiction_set_unchanged", "the admitted set already produces this root", {
            countryRoot: newRoot.toString(),
          });
        }
        const closure = await closeSupersededWindow(tx, pending);
        return {
          update: {
            assetId,
            admitted: unique,
            countryRoot: newRoot.toString(),
            txHash: closure.publication.txHash,
            leafCount: tree.leafCount,
            previousRootInvalidated: closure.publication.invalidatedAt !== null,
          },
          failure: closure.failure,
        };
      }

      const known = await lastPublication(tx, "JURISDICTION", assetId);
      const published = await publishOrAdopt(
        tx,
        newRoot,
        known,
        {
          publish: () => registry.publishCountryRoot(BigInt(assetId), newRoot, updates),
          current: (at) => registry.readCountryRoot(BigInt(assetId), { at }),
          find: (fromBlock, toBlock) => registry.findCountryRootPublication(BigInt(assetId), newRoot, fromBlock, toBlock),
        },
        { assetId },
      );
      const previousRoot = supersededRoot(published, known?.root ?? null, { assetId });
      const withdrawn = updates.some((change) => !change.admitted);

      const publication = await tx.rootPublication.create({
        data: {
          kind: "JURISDICTION",
          assetId,
          root: newRoot.toString(),
          previousRoot: previousRoot.toString(),
          leafCount: tree.leafCount,
          txHash: published.txHash,
          blockNumber: published.blockNumber,
          invalidationRequested: closeRootWindow && withdrawn && previousRoot !== 0n,
        },
      });
      const closure = await settleClosure(tx, publication);

      return {
        update: {
          assetId,
          admitted: unique,
          countryRoot: newRoot.toString(),
          txHash: published.txHash,
          leafCount: tree.leafCount,
          previousRootInvalidated: closure.publication.invalidatedAt !== null,
        },
        failure: closure.failure,
      };
    }),
    (value) => value.update,
  );
  return update;
}

export interface CredentialOpening {
  commitment: string;
  leafIndex: number;
  credentialRoot: string;
  opening: MerkleOpening;
}

/// The opening a wallet needs to build a proof. It changes on every publication,
/// so it is fetched rather than stored.
export async function credentialOpening(commitment: string): Promise<CredentialOpening> {
  const credential = await prisma.credential.findUnique({ where: { commitment } });
  if (!credential) throw apiError.notFound("credential_not_found", "no credential holds that commitment");
  if (!credential.inTree || credential.leafIndex === null) {
    throw apiError.conflict("credential_not_in_tree", "this credential is not in the registry", {
      status: credential.status,
    });
  }

  const tree = await buildCredentialTree();
  return {
    commitment,
    leafIndex: credential.leafIndex,
    credentialRoot: tree.root().toString(),
    opening: tree.opening(credential.leafIndex),
  };
}

export async function jurisdictionOpening(assetId: string, countryCode: number) {
  const leaf = await prisma.jurisdictionLeaf.findUnique({
    where: { assetId_countryCode: { assetId, countryCode } },
  });
  if (!leaf?.admitted) {
    throw apiError.notFound("jurisdiction_not_admitted", "this asset does not admit that jurisdiction", {
      assetId,
      countryCode,
    });
  }

  const tree = await buildJurisdictionTree(assetId);
  return {
    assetId,
    countryCode,
    leafIndex: leaf.leafIndex,
    countryRoot: tree.root().toString(),
    opening: tree.opening(leaf.leafIndex),
  };
}

export type ResolvedCredentialStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "EXPIRED" | "REVOKED";

/// Expiry is a fact about a date, not a state anybody writes: a credential whose
/// expiry has passed reads as expired even if no job has run. That holds for one
/// still awaiting activation too -- it can never be activated now.
export function resolveStatus(credential: Pick<Credential, "status" | "expiresAt">, now = new Date()): ResolvedCredentialStatus {
  if (credential.status === "REVOKED") return "REVOKED";
  if (credential.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  if (credential.status === "PENDING") return "PENDING";
  if (credential.status === "SUSPENDED") return "SUSPENDED";
  return "ACTIVE";
}
