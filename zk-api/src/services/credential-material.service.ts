import { createHmac } from "node:crypto";

import { config } from "../config/index.js";
import { isCountryCode, isTimestamp, requireFieldElement } from "../lib/field.js";
import { poseidonHash } from "../lib/poseidon.js";

/// What the issuer builds, and what it needs to build it.
///
/// The holder generates the secret and keeps it. The issuer receives
/// `secretHash = Poseidon(secret)` and nothing more, so it can build the leaf
/// the circuit expects while holding no preimage:
///
///   commitment = Poseidon(secretHash, country, expiry)
///   nullifier  = Poseidon(secret, assetId, epochEnd)
///
/// The issuer still fixes `country` and `expiry`, which come from the identity
/// check and are not the holder's to choose. What it can no longer do is compute
/// a nullifier or produce a proof, because both need the preimage.
///
/// `deriveNullifier` is here because its shape has to agree with the circuit and
/// that agreement is worth a test; the service never has a secret to feed it.

export async function deriveCommitment(secretHash: bigint, countryCode: number, expiry: bigint): Promise<bigint> {
  if (!isCountryCode(countryCode)) throw new Error("country code is outside [1, 2^16)");
  if (!isTimestamp(expiry)) throw new Error("expiry is outside the 64-bit encoding");
  requireFieldElement(secretHash, "secretHash");
  const hash = await poseidonHash();
  return hash(secretHash, BigInt(countryCode), expiry);
}

export async function deriveNullifier(secret: bigint, assetId: bigint, epochEnd: bigint): Promise<bigint> {
  const hash = await poseidonHash();
  return hash(secret, assetId, epochEnd);
}

/// A blinded handle on the KYC subject, so the database can refuse a second live
/// credential for the same person without ever storing the identifier the bank
/// uses. Its key is its own: it seals nothing and opens nothing, so losing it
/// costs the duplicate check and no credential.
export function subjectReference(kycSubjectId: string): string {
  return createHmac("sha256", config.subjectReferenceKey).update(kycSubjectId, "utf8").digest("hex");
}
