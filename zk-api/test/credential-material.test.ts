import { describe, expect, it } from "vitest";

import { FIELD_ORDER } from "../src/lib/field.js";
import { poseidonHash } from "../src/lib/poseidon.js";
import {
  deriveCommitment,
  deriveNullifier,
  subjectReference,
} from "../src/services/credential-material.service.js";
import { holderSecretHash } from "../src/lib/holder-secret.js";

const COUNTRY = 170;
const EXPIRY = 2_051_222_400n;
const ASSET = 42n;
const EPOCH_END = 2_210_976_000n;

const SECRET = 0x5eec12eb0ff1ce5eec12eb0ff1cen;

describe("the material the issuer builds", () => {
  it("builds the commitment the circuit builds, over the hash and not the secret", async () => {
    const hash = await poseidonHash();
    const secretHash = await holderSecretHash(SECRET);

    expect(await deriveCommitment(secretHash, COUNTRY, EXPIRY)).toBe(hash(secretHash, BigInt(COUNTRY), EXPIRY));
    expect(await deriveCommitment(secretHash, COUNTRY, EXPIRY)).toBe(hash(hash(SECRET), BigInt(COUNTRY), EXPIRY));
  });

  /// The shape the issuer used to build. It is a different leaf, which is the
  /// whole point: the value the issuer holds no longer opens the commitment.
  it("no longer agrees with a commitment built straight from the secret", async () => {
    const hash = await poseidonHash();
    const secretHash = await holderSecretHash(SECRET);
    expect(await deriveCommitment(secretHash, COUNTRY, EXPIRY)).not.toBe(hash(SECRET, BigInt(COUNTRY), EXPIRY));
  });

  it("builds the nullifier the circuit builds, one per asset and period", async () => {
    const hash = await poseidonHash();

    expect(await deriveNullifier(SECRET, ASSET, EPOCH_END)).toBe(hash(SECRET, ASSET, EPOCH_END));
    expect(await deriveNullifier(SECRET, 43n, EPOCH_END)).not.toBe(await deriveNullifier(SECRET, ASSET, EPOCH_END));
    expect(await deriveNullifier(SECRET, ASSET, EPOCH_END + 2_592_000n)).not.toBe(
      await deriveNullifier(SECRET, ASSET, EPOCH_END),
    );
  });

  /// What the issuer keeps is the hash. Feeding it to the nullifier -- the only
  /// thing it could do with what it has -- gives a tag no verifier accepts.
  it("cannot produce the holder's nullifier out of the hash it stores", async () => {
    const secretHash = await holderSecretHash(SECRET);
    expect(await deriveNullifier(secretHash, ASSET, EPOCH_END)).not.toBe(
      await deriveNullifier(SECRET, ASSET, EPOCH_END),
    );
  });

  it("refuses encodings the circuit's range checks would refuse", async () => {
    const secretHash = await holderSecretHash(SECRET);
    await expect(deriveCommitment(secretHash, 0, EXPIRY)).rejects.toThrow(/country code/);
    await expect(deriveCommitment(secretHash, 65_536, EXPIRY)).rejects.toThrow(/country code/);
    await expect(deriveCommitment(secretHash, COUNTRY, 1n << 64n)).rejects.toThrow(/64-bit/);
    await expect(deriveCommitment(FIELD_ORDER, COUNTRY, EXPIRY)).rejects.toThrow(/secretHash/);
  });
});

describe("the blinded handle on the KYC subject", () => {
  it("is stable, and keeps the identifier out of what is stored", () => {
    const reference = subjectReference("kyc-subject-000117");
    expect(reference).toMatch(/^[0-9a-f]{64}$/);
    expect(reference).toBe(subjectReference("kyc-subject-000117"));
    expect(reference).not.toContain("kyc-subject");
    expect(subjectReference("kyc-subject-000118")).not.toBe(reference);
  });
});
