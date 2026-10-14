import { poseidonHash } from "./poseidon.js";

/// The leaf the issuer publishes, computed on the holder's side so the holder can
/// check it before proving and find its own credential again after a restart.
export async function credentialCommitment(secretHash: bigint, countryCode: number, expiry: bigint): Promise<bigint> {
  return (await poseidonHash())(secretHash, BigInt(countryCode), expiry);
}

export async function credentialNullifier(secret: bigint, assetId: bigint, epochEnd: bigint): Promise<bigint> {
  return (await poseidonHash())(secret, assetId, epochEnd);
}

/// The issuer encodes the expiry as whole Unix seconds of the date it registered.
export function expiryOf(expiresAt: string | Date): bigint {
  const millis = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt.getTime();
  if (Number.isNaN(millis)) throw new Error("expiresAt is not a date");
  return BigInt(Math.floor(millis / 1000));
}
