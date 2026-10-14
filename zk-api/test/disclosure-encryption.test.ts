import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config/index.js";
import { toBuffer } from "../src/lib/bytes.js";
import { prisma } from "../src/lib/prisma.js";
import { open, publicKeyOf, seal } from "../src/lib/sealed-box.js";
import {
  envelopeAad,
  openIdentity,
  rotateEnvelopes,
  sealIdentity,
  toEnvelopeColumns,
  toSealedEnvelope,
  type HolderIdentity,
} from "../src/services/disclosure.service.js";
import { resetDatabase } from "./helpers/database.js";

const ACTIVE_KEY = "vk-2026-09";
const SUPERSEDED_KEY = "vk-2026-03";
/// The envelope is bound to the credential's row identifier, which exists from
/// the moment the bank's verdict lands and long before there is a commitment.
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const COMMITMENT_A = "1234567890123456789012345678901234567890";

const identity: HolderIdentity = {
  legalName: "Ana María Restrepo Gil",
  documentType: "CC",
  documentNumber: "1020304050",
  countryCode: 170,
  dateOfBirth: "1984-03-11",
  residenceAddress: "Carrera 43A 1-50, Medellín",
  kycProvider: "banco-verificacion",
  kycReference: "VF-2026-000117",
};

async function storeEnvelopeFor(commitment: string, viewingKeyId: string): Promise<string> {
  const credentialId = randomUUID();
  const credential = await prisma.credential.create({
    data: {
      id: credentialId,
      commitment,
      secretHash: commitment,
      subjectRef: randomBytes(32).toString("hex"),
      holderAddress: `0x${randomBytes(20).toString("hex")}`,
      leafIndex: Number(commitment.slice(-4)) % 1000,
      countryCode: identity.countryCode,
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      status: "ACTIVE",
      inTree: true,
      verificationRef: "VF-2026-000117",
      envelope: { create: toEnvelopeColumns(sealIdentity(identity, credentialId, viewingKeyId)) },
    },
  });
  return credential.id;
}

beforeEach(async () => {
  await resetDatabase();
});

describe("sealing the holder's identity", () => {
  it("opens back to exactly what was sealed", () => {
    expect(openIdentity(sealIdentity(identity, CREDENTIAL_ID))).toEqual(identity);
  });

  it("draws a fresh ephemeral key per record, so two seals of the same data differ", () => {
    const first = sealIdentity(identity, CREDENTIAL_ID);
    const second = sealIdentity(identity, CREDENTIAL_ID);

    expect(first.ephemeralPublicKey.equals(second.ephemeralPublicKey)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(openIdentity(second)).toEqual(openIdentity(first));
  });

  it("seals with the public half alone, so enrolling never touches the key that opens", () => {
    const publicHalf = publicKeyOf(config.disclosure.viewingKeys.get(ACTIVE_KEY)!);
    const envelope = seal(Buffer.from("payload", "utf8"), publicHalf, ACTIVE_KEY, Buffer.from("aad", "utf8"));
    const opened = open(envelope, config.disclosure.viewingKeys.get(ACTIVE_KEY)!);
    expect(opened.toString("utf8")).toBe("payload");
  });

  it("refuses to open with the wrong viewing key", () => {
    const envelope = sealIdentity(identity, CREDENTIAL_ID, ACTIVE_KEY);
    expect(() => open(envelope, config.disclosure.viewingKeys.get(SUPERSEDED_KEY)!)).toThrow();
  });

  /// The associated data is what stops an envelope being lifted onto another
  /// credential: authentication fails instead of the record quietly naming the
  /// wrong person.
  it("refuses an envelope moved onto another credential", () => {
    const envelope = sealIdentity(identity, CREDENTIAL_ID);
    const moved = { ...envelope, aad: envelopeAad("22222222-2222-4222-8222-222222222222", envelope.viewingKeyId) };
    expect(() => openIdentity(moved)).toThrow(/did not authenticate/);
  });

  it("refuses an envelope whose ciphertext was edited", () => {
    const envelope = sealIdentity(identity, CREDENTIAL_ID);
    const tampered = Buffer.from(envelope.ciphertext);
    tampered.writeUInt8(tampered.readUInt8(0) ^ 0xff, 0);
    expect(() => openIdentity({ ...envelope, ciphertext: tampered })).toThrow(/did not authenticate/);
  });

  it("refuses an envelope whose authentication tag was edited", () => {
    const envelope = sealIdentity(identity, CREDENTIAL_ID);
    const tag = Buffer.from(envelope.authTag);
    tag.writeUInt8(tag.readUInt8(0) ^ 0xff, 0);
    expect(() => openIdentity({ ...envelope, authTag: tag })).toThrow(/did not authenticate/);
  });

  it("fails loudly when the viewing key is not configured", () => {
    const envelope = sealIdentity(identity, CREDENTIAL_ID);
    expect(() => openIdentity({ ...envelope, viewingKeyId: "vk-not-configured" })).toThrow(
      /no material configured for viewing key/,
    );
  });

  it("never lets the identity reach the database in the clear", async () => {
    await storeEnvelopeFor(COMMITMENT_A, ACTIVE_KEY);
    const row = await prisma.identityEnvelope.findFirstOrThrow();
    const stored = toBuffer(row.ciphertext).toString("utf8");
    expect(stored).not.toContain("Restrepo");
    expect(stored).not.toContain("1020304050");
  });
});

describe("rotating the viewing key", () => {
  it("re-seals every envelope against the new key and still opens them", async () => {
    await storeEnvelopeFor(COMMITMENT_A, SUPERSEDED_KEY);
    await storeEnvelopeFor("2222222222222222222222222222222222222222", SUPERSEDED_KEY);

    const before = await prisma.identityEnvelope.findMany();
    expect(before.every((row) => row.viewingKeyId === SUPERSEDED_KEY)).toBe(true);

    const result = await rotateEnvelopes(ACTIVE_KEY);
    expect(result).toMatchObject({ rotated: 2, failed: [] });

    const after = await prisma.identityEnvelope.findMany({ include: { credential: true } });
    expect(after.every((row) => row.viewingKeyId === ACTIVE_KEY)).toBe(true);
    expect(after.every((row) => row.resealedAt !== null)).toBe(true);

    for (const row of after) {
      expect(openIdentity(toSealedEnvelope(row))).toEqual(identity);
    }
  });

  it("produces a ciphertext that shares nothing with the one it replaced", async () => {
    await storeEnvelopeFor(COMMITMENT_A, SUPERSEDED_KEY);
    const before = await prisma.identityEnvelope.findFirstOrThrow();

    await rotateEnvelopes(ACTIVE_KEY);
    const after = await prisma.identityEnvelope.findFirstOrThrow();

    expect(toBuffer(after.ciphertext).equals(toBuffer(before.ciphertext))).toBe(false);
    expect(toBuffer(after.ephemeralPublicKey).equals(toBuffer(before.ephemeralPublicKey))).toBe(false);
    expect(toBuffer(after.nonce).equals(toBuffer(before.nonce))).toBe(false);
  });

  it("leaves envelopes already on the target key alone", async () => {
    await storeEnvelopeFor(COMMITMENT_A, ACTIVE_KEY);
    const result = await rotateEnvelopes(ACTIVE_KEY);
    expect(result).toMatchObject({ rotated: 0, alreadyCurrent: 1, failed: [] });
  });

  it("refuses to rotate onto a key with no material configured", async () => {
    await expect(rotateEnvelopes("vk-not-configured")).rejects.toThrow(/no material configured/);
  });
});
