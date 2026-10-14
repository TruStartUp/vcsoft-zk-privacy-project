import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { config } from "../config/index.js";
import { apiError } from "../lib/errors.js";
import { isFieldElement } from "../lib/field.js";
import { prisma } from "../lib/prisma.js";
import {
  PUBLIC_SIGNAL_COUNT,
  codecFor,
  publicSignalsOf,
  schemeOf,
  type ProofCallData,
  type ProofScheme,
} from "../lib/proof-codec.js";
import * as registry from "./registry.service.js";

export type { Groth16CallData, PlonkCallData, ProofCallData, PublicSignalTuple } from "../lib/proof-codec.js";

export const PUBLIC_SIGNAL_NAMES = [
  "credentialRoot",
  "countryRoot",
  "assetId",
  "epochEnd",
  "nullifier",
  "anchor",
] as const;

export interface PublicSignals {
  credentialRoot: bigint;
  countryRoot: bigint;
  assetId: bigint;
  epochEnd: bigint;
  nullifier: bigint;
  anchor: bigint;
}

/// Why a proof was not turned into an attestation. Exported as values, not only as a
/// type, because the specification carries the same list and a test compares the two.
export const REJECTION_CODES = [
  "public_signal_out_of_field",
  "invalid_proof",
  "credential_root_not_valid",
  "country_root_not_valid",
  "asset_not_registered",
  "epoch_end_not_claimable",
  "nullifier_already_spent",
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

export interface VerificationOutcome {
  id: string;
  scheme: ProofScheme;
  valid: boolean;
  rejectionCode: RejectionCode | null;
  publicSignals: Record<(typeof PUBLIC_SIGNAL_NAMES)[number], string>;
  proofDigest: string;
  verifiedAt: string;
}

/// Which proving scheme this deployment verifies under, and the verifying key that goes
/// with it. One value, read from configuration, and the only thing that changes for the
/// service to answer under another scheme.
export interface ProofBackend {
  scheme: ProofScheme;
  verificationKeyPath: string;
}

export function configuredBackend(): ProofBackend {
  return { scheme: config.proof.scheme, verificationKeyPath: config.proof.verificationKeyPath };
}

const verificationKeys = new Map<string, { protocol?: string }>();

/// The verifying key is a deployment artefact, not something this service can
/// invent. Without it there is no answer to give, so the request fails loudly
/// rather than returning a verdict nobody computed.
///
/// The key names the scheme it belongs to, and a key from the other one is a
/// misconfigured deployment rather than a bad proof: it is refused here so that the
/// mistake is reported as what it is instead of turning every honest proof invalid.
async function loadVerificationKey(backend: ProofBackend): Promise<unknown> {
  const path = resolve(process.cwd(), backend.verificationKeyPath);
  let key = verificationKeys.get(backend.verificationKeyPath);

  if (!key) {
    try {
      key = JSON.parse(await readFile(path, "utf8")) as { protocol?: string };
    } catch (cause) {
      throw apiError.failedDependency("verification_key_unavailable", "the verifying key could not be read", {
        path,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
    verificationKeys.set(backend.verificationKeyPath, key);
  }

  const protocol = (key as { protocol?: string }).protocol;
  if (protocol !== backend.scheme) {
    throw apiError.failedDependency(
      "verification_key_scheme_mismatch",
      "the verifying key belongs to another proving scheme",
      { path, expected: backend.scheme, found: protocol ?? null },
    );
  }

  return key;
}

export function resetVerificationKeyCache(): void {
  verificationKeys.clear();
}

export function parsePublicSignals(signals: readonly string[]): PublicSignals {
  if (signals.length !== PUBLIC_SIGNAL_COUNT) {
    throw apiError.badRequest("public_signal_count", `the circuit has ${PUBLIC_SIGNAL_COUNT} public signals`, {
      received: signals.length,
    });
  }
  const values = signals.map((signal, index) => {
    let value: bigint;
    try {
      value = BigInt(signal);
    } catch {
      throw apiError.badRequest("public_signal_malformed", `public signal ${index} is not an integer`, {
        signal: PUBLIC_SIGNAL_NAMES[index],
      });
    }
    return value;
  });

  return {
    credentialRoot: values[0]!,
    countryRoot: values[1]!,
    assetId: values[2]!,
    epochEnd: values[3]!,
    nullifier: values[4]!,
    anchor: values[5]!,
  };
}

export function proofDigestOf(callData: ProofCallData): string {
  const body = "a" in callData ? [callData.a, callData.b, callData.c] : [callData.proof];
  return createHash("sha256")
    .update(JSON.stringify([...body, callData.signals]), "utf8")
    .digest("hex");
}

/// Mirrors what `ComplianceAttestor` refuses before the pairing check, on either
/// entry (`attest` or `attestFor`), except the anchor: binding the proof to a
/// subject needs the subject, and a verification request does not name one.
/// Verifying the proof alone answers "these numbers are consistent"; it does not
/// answer "this attestation would stand", which is what a bank is asking.
///
/// Every read is made at one block, so the verdict describes a single state of the
/// chain and never one from before this service's own last publication.
async function checkAgainstChainState(signals: PublicSignals): Promise<RejectionCode | null> {
  for (const name of PUBLIC_SIGNAL_NAMES) {
    if (!isFieldElement(signals[name])) return "public_signal_out_of_field";
  }

  const at = { at: await registry.stateBlock() };
  const [epochLength, currentEpochEnd] = await Promise.all([
    registry.readEpochLength(at),
    registry.readCurrentEpochEnd(at),
  ]);
  if (signals.epochEnd !== currentEpochEnd && signals.epochEnd !== currentEpochEnd + epochLength) {
    return "epoch_end_not_claimable";
  }

  if (!(await registry.isCredentialRootValid(signals.credentialRoot, at))) return "credential_root_not_valid";
  if ((await registry.readCountryRoot(signals.assetId, at)) === 0n) return "asset_not_registered";
  if (!(await registry.isCountryRootValid(signals.assetId, signals.countryRoot, at))) return "country_root_not_valid";
  if (await registry.isNullifierSpent(signals.nullifier, at)) return "nullifier_already_spent";

  return null;
}

/// A payload written in a scheme this deployment does not verify is refused outright.
/// Answering "invalid proof" would be a verdict nobody computed: the numbers are not
/// wrong, they are addressed to another verifier.
function requireConfiguredScheme(callData: ProofCallData, backend: ProofBackend): void {
  const presented = schemeOf(callData);
  if (presented !== backend.scheme) {
    throw apiError.badRequest("proof_scheme_mismatch", "this deployment does not verify proofs of that scheme", {
      expected: backend.scheme,
      received: presented,
    });
  }
}

export async function verifyProof(
  callData: ProofCallData,
  partnerId?: string,
  backend: ProofBackend = configuredBackend(),
): Promise<VerificationOutcome> {
  requireConfiguredScheme(callData, backend);

  const signals = parsePublicSignals(publicSignalsOf(callData));
  const proofDigest = proofDigestOf(callData);

  let rejectionCode: RejectionCode | null = null;
  for (const name of PUBLIC_SIGNAL_NAMES) {
    if (!isFieldElement(signals[name])) rejectionCode = "public_signal_out_of_field";
  }

  if (!rejectionCode) {
    const key = await loadVerificationKey(backend);
    const proofValid = await codecFor(backend.scheme).verify(key, callData);
    rejectionCode = proofValid ? await checkAgainstChainState(signals) : "invalid_proof";
  }

  const record = await prisma.proofVerification.create({
    data: {
      partnerId: partnerId ?? null,
      scheme: backend.scheme,
      assetId: signals.assetId.toString(),
      nullifier: signals.nullifier.toString(),
      epochEnd: signals.epochEnd,
      credentialRoot: signals.credentialRoot.toString(),
      countryRoot: signals.countryRoot.toString(),
      anchor: signals.anchor.toString(),
      proofDigest,
      valid: rejectionCode === null,
      rejectionCode,
    },
  });

  return {
    id: record.id,
    scheme: backend.scheme,
    valid: record.valid,
    rejectionCode,
    publicSignals: {
      credentialRoot: signals.credentialRoot.toString(),
      countryRoot: signals.countryRoot.toString(),
      assetId: signals.assetId.toString(),
      epochEnd: signals.epochEnd.toString(),
      nullifier: signals.nullifier.toString(),
      anchor: signals.anchor.toString(),
    },
    proofDigest,
    verifiedAt: record.verifiedAt.toISOString(),
  };
}

export interface VerificationStanding {
  id: string;
  scheme: string;
  valid: boolean;
  rejectionCode: string | null;
  verifiedAt: string;
  assetId: string;
  nullifier: string;
  epochEnd: string;
  standing: "live" | "expired" | "superseded_root" | "never_valid";
  credentialRootStillValid: boolean;
  nullifierSpent: boolean;
  epochEndsAt: string;
}

/// What a bank asks after the fact: is the proof I validated still standing? A
/// proof does not expire on its own -- the attestation it earns does, when the
/// period it claimed ends or the root it was built against is dropped.
///
/// The scheme comes back with it, because a rotation is allowed and a verdict is only
/// readable next to the verifier that reached it.
export async function verificationStanding(id: string): Promise<VerificationStanding> {
  const record = await prisma.proofVerification.findUnique({ where: { id } });
  if (!record) throw apiError.notFound("verification_not_found", "no such proof verification");

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const at = { at: await registry.stateBlock() };
  const [credentialRootStillValid, nullifierSpent] = await Promise.all([
    registry.isCredentialRootValid(BigInt(record.credentialRoot), at),
    registry.isNullifierSpent(BigInt(record.nullifier), at),
  ]);

  let standing: VerificationStanding["standing"];
  if (!record.valid) standing = "never_valid";
  else if (record.epochEnd <= nowSeconds) standing = "expired";
  else if (!credentialRootStillValid) standing = "superseded_root";
  else standing = "live";

  return {
    id: record.id,
    scheme: record.scheme,
    valid: record.valid,
    rejectionCode: record.rejectionCode,
    verifiedAt: record.verifiedAt.toISOString(),
    assetId: record.assetId,
    nullifier: record.nullifier,
    epochEnd: record.epochEnd.toString(),
    standing,
    credentialRootStillValid,
    nullifierSpent,
    epochEndsAt: new Date(Number(record.epochEnd) * 1000).toISOString(),
  };
}
