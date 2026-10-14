import { createHash } from "node:crypto";

import type { DisclosureStatus, IdentityEnvelope, Prisma } from "@prisma/client";

import { config } from "../config/index.js";
import { apiError } from "../lib/errors.js";
import { prisma, type PrismaTransaction } from "../lib/prisma.js";
import { toBuffer, toBytes } from "../lib/bytes.js";
import { open, publicKeyOf, seal, type SealedEnvelope } from "../lib/sealed-box.js";

export interface HolderIdentity {
  legalName: string;
  documentType: string;
  documentNumber: string;
  countryCode: number;
  dateOfBirth?: string;
  residenceAddress?: string;
  kycProvider?: string;
  kycReference?: string;
  [attribute: string]: unknown;
}

export interface DisclosureRequestInput {
  partnerId: string;
  requesterRef: string;
  justification: string;
  legalBasis: string;
  scope: string[];
  targetCommitment: string;
  requestSignature: string;
  requestDigest: string;
}

export const DISCLOSURE_SCOPES = [
  "identity.legalName",
  "identity.documentType",
  "identity.documentNumber",
  "identity.countryCode",
  "identity.dateOfBirth",
  "identity.residenceAddress",
  "identity.kycProvider",
  "identity.kycReference",
] as const;

function viewingKeyMaterial(keyId: string): Buffer {
  const material = config.disclosure.viewingKeys.get(keyId);
  if (!material) {
    throw apiError.failedDependency(
      "viewing_key_unavailable",
      `no material configured for viewing key "${keyId}"`,
      { viewingKeyId: keyId },
    );
  }
  return material;
}

/// Binds a ciphertext to the credential it belongs to and to the key that sealed
/// it. Moving an envelope onto another credential, or replaying it under a
/// rotated key id, fails to authenticate rather than opening into someone else.
///
/// It binds the credential's row identifier and not its commitment, because the
/// identity is sealed when the bank's verdict arrives and the commitment does
/// not exist until the holder activates. The identifier is fixed from the first
/// moment and never changes.
export function envelopeAad(credentialId: string, viewingKeyId: string): Buffer {
  return Buffer.from(`vcsoft/zk-api/identity/v1\n${credentialId}\n${viewingKeyId}`, "utf8");
}

export function sealIdentity(
  identity: HolderIdentity,
  credentialId: string,
  viewingKeyId: string = config.disclosure.activeViewingKeyId,
): SealedEnvelope {
  const recipientPublic = publicKeyOf(viewingKeyMaterial(viewingKeyId));
  const plaintext = Buffer.from(JSON.stringify(identity), "utf8");
  return seal(plaintext, recipientPublic, viewingKeyId, envelopeAad(credentialId, viewingKeyId));
}

export function openIdentity(envelope: SealedEnvelope): HolderIdentity {
  const material = viewingKeyMaterial(envelope.viewingKeyId);
  try {
    return JSON.parse(open(envelope, material).toString("utf8")) as HolderIdentity;
  } catch (cause) {
    throw apiError.internal("envelope_authentication_failed", "the sealed identity did not authenticate", {
      viewingKeyId: envelope.viewingKeyId,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export function toSealedEnvelope(row: IdentityEnvelope): SealedEnvelope {
  return {
    viewingKeyId: row.viewingKeyId,
    ephemeralPublicKey: toBuffer(row.ephemeralPublicKey),
    nonce: toBuffer(row.nonce),
    authTag: toBuffer(row.authTag),
    ciphertext: toBuffer(row.ciphertext),
    aad: toBuffer(row.aad),
  };
}

export function toEnvelopeColumns(envelope: SealedEnvelope) {
  return {
    viewingKeyId: envelope.viewingKeyId,
    ephemeralPublicKey: toBytes(envelope.ephemeralPublicKey),
    nonce: toBytes(envelope.nonce),
    authTag: toBytes(envelope.authTag),
    ciphertext: toBytes(envelope.ciphertext),
    aad: toBytes(envelope.aad),
  };
}

/// Rotation, in the order it has to happen: the superseded private key stays in
/// configuration while every envelope is opened with it and re-sealed against
/// the new public half, and only then is it dropped from the secret manager.
/// Re-sealing draws a new ephemeral key, so the new ciphertext shares nothing
/// with the old one.
///
/// One call re-seals up to `batchSize` envelopes and walks past the ones it cannot
/// open, so failures never hide the envelopes behind them: when a call rotates
/// nothing, `failed` is every envelope left and `remaining` says how many that is.
export async function rotateEnvelopes(
  toKeyId: string = config.disclosure.activeViewingKeyId,
  batchSize = 200,
): Promise<{ rotated: number; alreadyCurrent: number; failed: string[]; remaining: number }> {
  viewingKeyMaterial(toKeyId);

  const alreadyCurrent = await prisma.identityEnvelope.count({ where: { viewingKeyId: toKeyId } });
  const failed: string[] = [];
  let rotated = 0;
  let after: string | undefined;

  while (rotated < batchSize) {
    const page = await prisma.identityEnvelope.findMany({
      where: { viewingKeyId: { not: toKeyId }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (page.length === 0) break;
    after = page.at(-1)!.id;

    for (const row of page) {
      if (rotated >= batchSize) break;
      try {
        const identity = openIdentity(toSealedEnvelope(row));
        const resealed = sealIdentity(identity, row.credentialId, toKeyId);
        await prisma.identityEnvelope.update({
          where: { id: row.id },
          data: { ...toEnvelopeColumns(resealed), resealedAt: new Date() },
        });
        rotated += 1;
      } catch {
        failed.push(row.credentialId);
      }
    }
  }

  const remaining = await prisma.identityEnvelope.count({ where: { viewingKeyId: { not: toKeyId } } });
  return { rotated, alreadyCurrent, failed, remaining };
}

export function requestDigestOf(input: Omit<DisclosureRequestInput, "requestDigest">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.partnerId,
        input.requesterRef,
        input.justification,
        input.legalBasis,
        [...input.scope].sort(),
        input.targetCommitment,
      ]),
      "utf8",
    )
    .digest("hex");
}

export async function createDisclosureRequest(input: DisclosureRequestInput, tx: PrismaTransaction = prisma) {
  const credential = await tx.credential.findUnique({
    where: { commitment: input.targetCommitment },
    select: { id: true },
  });
  if (!credential) {
    throw apiError.notFound("credential_not_found", "no credential holds that commitment", {
      commitment: input.targetCommitment,
    });
  }

  return tx.disclosureRequest.create({
    data: {
      partnerId: input.partnerId,
      requesterRef: input.requesterRef,
      justification: input.justification,
      legalBasis: input.legalBasis,
      scope: input.scope,
      targetCommitment: input.targetCommitment,
      requestSignature: input.requestSignature,
      requestDigest: input.requestDigest,
      status: "PENDING",
    },
  });
}

/// The authenticated party behind a decision: the partner whose signature carried
/// it and the person it says it acted for.
export interface Decider {
  partnerId: string;
  actorRef: string | null;
}

const withDecider = { decider: { select: { partnerKey: true } } } as const;

export type DisclosureRecord = Prisma.DisclosureRequestGetPayload<{ include: typeof withDecider }>;

export async function findDisclosureRequest(requestId: string): Promise<DisclosureRecord> {
  const request = await prisma.disclosureRequest.findUnique({ where: { id: requestId }, include: withDecider });
  if (!request) throw apiError.notFound("disclosure_request_not_found", "no such disclosure request");
  return request;
}

/// Separation of duties is a property of each request, not of how scopes happen to
/// be handed out: whoever asked cannot decide, whatever scopes it holds. Who decided
/// is taken from the authentication; `decidedBy` is kept as what the partner declared.
export async function decideDisclosureRequest(
  requestId: string,
  decision: Extract<DisclosureStatus, "APPROVED" | "DENIED">,
  decider: Decider,
  decidedBy?: string,
  decisionNote?: string,
): Promise<DisclosureRecord> {
  const request = await findDisclosureRequest(requestId);
  if (request.partnerId === decider.partnerId) {
    throw apiError.forbidden("disclosure_self_decision", "a request is decided by a party other than the one that made it", {
      disclosureId: requestId,
    });
  }

  const decided = await prisma.disclosureRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: {
      status: decision,
      decidedByPartnerId: decider.partnerId,
      decidedByActor: decider.actorRef,
      decidedBy: decidedBy ?? null,
      decisionNote: decisionNote ?? null,
      decidedAt: new Date(),
    },
  });
  if (decided.count === 0) {
    const current = await findDisclosureRequest(requestId);
    throw apiError.conflict("disclosure_request_already_decided", "this request was already decided", {
      status: current.status,
    });
  }

  return findDisclosureRequest(requestId);
}

/// Releases only the attributes the approved scope names, and only to the partner
/// that asked for them. Everything else stays sealed, so an approval for one
/// attribute is not an approval for the record, and holding `disclosures:read` is
/// not a claim on somebody else's request.
export async function releaseDisclosure(requestId: string, partnerId: string): Promise<{
  scope: string[];
  released: Record<string, unknown>;
  releasedAt: Date;
}> {
  const request = await findDisclosureRequest(requestId);
  if (request.partnerId !== partnerId) {
    throw apiError.forbidden("disclosure_not_requester", "only the partner that made the request can release it", {
      disclosureId: requestId,
    });
  }
  if (request.status !== "APPROVED") {
    throw apiError.forbidden("disclosure_not_approved", "this request has not been approved", {
      status: request.status,
    });
  }

  return prisma.$transaction(async (tx) => {
    const releasedAt = new Date();
    const claimed = await tx.disclosureRequest.updateMany({
      where: { id: requestId, status: "APPROVED" },
      data: { status: "RELEASED", releasedAt },
    });
    if (claimed.count === 0) {
      throw apiError.forbidden("disclosure_not_approved", "this request has not been approved", { status: "RELEASED" });
    }

    const credential = await tx.credential.findUnique({
      where: { commitment: request.targetCommitment },
      include: { envelope: true },
    });
    if (!credential?.envelope) {
      throw apiError.notFound("identity_envelope_not_found", "no sealed identity for that commitment", {
        commitment: request.targetCommitment,
      });
    }

    const identity = openIdentity(toSealedEnvelope(credential.envelope));
    const released: Record<string, unknown> = {};
    for (const scope of request.scope) {
      const attribute = scope.replace(/^identity\./, "");
      if (attribute in identity) released[attribute] = identity[attribute];
    }

    return { scope: request.scope, released, releasedAt };
  });
}

export function disclosureView(request: Prisma.DisclosureRequestGetPayload<object> & { decider?: { partnerKey: string } | null }) {
  return {
    id: request.id,
    status: request.status,
    requesterRef: request.requesterRef,
    justification: request.justification,
    legalBasis: request.legalBasis,
    scope: request.scope,
    targetCommitment: request.targetCommitment,
    requestDigest: request.requestDigest,
    requestedAt: request.requestedAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    decidedBy: request.decidedBy,
    decidedByPartnerKey: request.decider?.partnerKey ?? null,
    decidedByActor: request.decidedByActor,
    releasedAt: request.releasedAt?.toISOString() ?? null,
  };
}
