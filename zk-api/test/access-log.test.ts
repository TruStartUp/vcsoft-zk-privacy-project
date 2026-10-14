import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config/index.js";
import { GENESIS_HASH, chainEntry, verifyChain, type ChainedFields } from "../src/lib/hash-chain.js";
import { prisma } from "../src/lib/prisma.js";
import { recordAccess, verifyAccessLogIntegrity } from "../src/services/access-log.service.js";
import { resetDatabase } from "./helpers/database.js";

function entryFields(sequence: bigint, overrides: Partial<ChainedFields> = {}): ChainedFields {
  return {
    sequence,
    partnerKey: "pk_bank",
    actorRef: "auditor-7",
    method: "GET",
    path: "/v1/access-log",
    scope: "audit:read",
    resourceType: "access_log",
    resourceId: null,
    outcome: "granted",
    statusCode: 200,
    requestDigest: "a".repeat(64),
    occurredAt: new Date("2026-09-03T12:00:00.000Z"),
    ...overrides,
  };
}

async function appendEntries(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await recordAccess({
      partnerId: null,
      partnerKey: "pk_bank",
      actorRef: `auditor-${index}`,
      method: "GET",
      path: `/v1/credentials/${index}`,
      scope: "credentials:read",
      resourceType: "credential",
      resourceId: String(index),
      outcome: index % 3 === 0 ? "refused" : "granted",
      statusCode: index % 3 === 0 ? 403 : 200,
      requestDigest: randomBytes(32).toString("hex"),
    });
  }
}

beforeEach(async () => {
  await resetDatabase();
});

describe("the access log hash chain", () => {
  it("verifies a chain built the way the service builds it", () => {
    const first = entryFields(1n);
    const firstHash = chainEntry(config.accessLogHmacKey, first, GENESIS_HASH);
    const second = entryFields(2n, { path: "/v1/disclosures" });
    const secondHash = chainEntry(config.accessLogHmacKey, second, firstHash);

    expect(
      verifyChain(config.accessLogHmacKey, [
        { ...first, previousHash: GENESIS_HASH, entryHash: firstHash },
        { ...second, previousHash: firstHash, entryHash: secondHash },
      ]),
    ).toMatchObject({ intact: true, checked: 2 });
  });

  it("catches an entry whose content was edited after the fact", () => {
    const first = entryFields(1n);
    const firstHash = chainEntry(config.accessLogHmacKey, first, GENESIS_HASH);

    const edited = { ...first, outcome: "granted", statusCode: 200, path: "/v1/nothing-to-see" };
    expect(
      verifyChain(config.accessLogHmacKey, [{ ...edited, previousHash: GENESIS_HASH, entryHash: firstHash }]),
    ).toMatchObject({ intact: false, reason: "hash_mismatch", brokenAtSequence: 1n });
  });

  it("catches an entry removed from the middle", () => {
    const first = entryFields(1n);
    const firstHash = chainEntry(config.accessLogHmacKey, first, GENESIS_HASH);
    const second = entryFields(2n);
    const secondHash = chainEntry(config.accessLogHmacKey, second, firstHash);
    const third = entryFields(3n);
    const thirdHash = chainEntry(config.accessLogHmacKey, third, secondHash);

    expect(
      verifyChain(config.accessLogHmacKey, [
        { ...first, previousHash: GENESIS_HASH, entryHash: firstHash },
        { ...third, previousHash: secondHash, entryHash: thirdHash },
      ]),
    ).toMatchObject({ intact: false, reason: "sequence_gap", brokenAtSequence: 3n });
  });

  /// A plain hash chain is only tamper-evident against someone who cannot
  /// recompute it, and whoever can write the table can. Keying it moves the bar
  /// to the secret manager.
  it("cannot be recomputed without the key, so a forged entry stays visible", () => {
    const forged = entryFields(1n);
    const forgedHash = chainEntry(randomBytes(32), forged, GENESIS_HASH);

    expect(
      verifyChain(config.accessLogHmacKey, [{ ...forged, previousHash: GENESIS_HASH, entryHash: forgedHash }]),
    ).toMatchObject({ intact: false, reason: "hash_mismatch" });
  });
});

describe("the access log in the database", () => {
  it("chains what it appends and verifies intact", async () => {
    await appendEntries(5);

    const stored = await prisma.accessLogEntry.findMany({ orderBy: { sequence: "asc" } });
    expect(stored.map((entry) => entry.sequence)).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(stored[0]!.previousHash).toBe(GENESIS_HASH);
    expect(stored[1]!.previousHash).toBe(stored[0]!.entryHash);

    expect(await verifyAccessLogIntegrity()).toMatchObject({ intact: true, entries: 5 });
  });

  it("records refusals as faithfully as grants", async () => {
    await appendEntries(3);
    const refused = await prisma.accessLogEntry.findMany({ where: { outcome: "refused" } });
    expect(refused).toHaveLength(1);
    expect(refused[0]!.statusCode).toBe(403);
  });

  it("refuses an UPDATE, whoever issues it", async () => {
    await appendEntries(1);
    await expect(
      prisma.$executeRawUnsafe("UPDATE access_log_entries SET outcome = 'granted' WHERE sequence = 1"),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses a DELETE, whoever issues it", async () => {
    await appendEntries(1);
    await expect(prisma.$executeRawUnsafe("DELETE FROM access_log_entries WHERE sequence = 1")).rejects.toThrow(
      /append-only/,
    );
  });

  it("refuses a TRUNCATE", async () => {
    await appendEntries(1);
    await expect(prisma.$executeRawUnsafe("TRUNCATE TABLE access_log_entries")).rejects.toThrow(/append-only/);
  });

  it("leaves the entry untouched after a refused edit", async () => {
    await appendEntries(1);
    const before = await prisma.accessLogEntry.findFirstOrThrow();

    await expect(
      prisma.$executeRawUnsafe("UPDATE access_log_entries SET path = '/v1/hidden' WHERE sequence = 1"),
    ).rejects.toThrow();

    const after = await prisma.accessLogEntry.findFirstOrThrow();
    expect(after).toEqual(before);
    expect(await verifyAccessLogIntegrity()).toMatchObject({ intact: true });
  });

  /// An INSERT is the one write the trigger allows, because appending is the
  /// point. The chain is what makes an appended lie visible.
  it("catches a row inserted straight into the table without the key", async () => {
    await appendEntries(2);

    await prisma.$executeRawUnsafe(`
      INSERT INTO access_log_entries
        (id, sequence, "partnerKey", "actorRef", method, path, scope, "resourceType", "resourceId",
         outcome, "statusCode", "requestDigest", "previousHash", "entryHash", "occurredAt")
      VALUES
        (gen_random_uuid(), 3, 'pk_bank', NULL, 'GET', '/v1/forged', NULL, 'credential', NULL,
         'granted', 200, '${"b".repeat(64)}', (SELECT "entryHash" FROM access_log_entries WHERE sequence = 2),
         '${"c".repeat(64)}', NOW())
    `);

    expect(await verifyAccessLogIntegrity()).toMatchObject({
      intact: false,
      reason: "hash_mismatch",
      brokenAtSequence: 3n,
    });
  });

  it("verifies page by page with the same verdicts as in one pass", async () => {
    await appendEntries(7);
    expect(await verifyAccessLogIntegrity(2)).toMatchObject({ intact: true, entries: 7, checked: 7 });

    await prisma.$executeRawUnsafe("ALTER TABLE access_log_entries DISABLE TRIGGER USER");
    await prisma.$executeRawUnsafe("UPDATE access_log_entries SET path = '/v1/edited' WHERE sequence = 4");
    await prisma.$executeRawUnsafe("ALTER TABLE access_log_entries ENABLE TRIGGER USER");
    expect(await verifyAccessLogIntegrity(2)).toMatchObject({ intact: false, reason: "hash_mismatch", brokenAtSequence: 4n, checked: 3 });
    expect(await verifyAccessLogIntegrity(3)).toMatchObject({ intact: false, reason: "hash_mismatch", brokenAtSequence: 4n, checked: 3 });
  });

  it("names a gap that falls between two pages", async () => {
    await appendEntries(6);
    await prisma.$executeRawUnsafe("ALTER TABLE access_log_entries DISABLE TRIGGER USER");
    await prisma.$executeRawUnsafe("DELETE FROM access_log_entries WHERE sequence = 5");
    await prisma.$executeRawUnsafe("ALTER TABLE access_log_entries ENABLE TRIGGER USER");

    expect(await verifyAccessLogIntegrity(4)).toMatchObject({ intact: false, reason: "sequence_gap", brokenAtSequence: 6n });
    expect(await verifyAccessLogIntegrity(2)).toMatchObject({ intact: false, reason: "sequence_gap", brokenAtSequence: 6n });
  });

  it("verifies an empty log rather than failing on it", async () => {
    expect(await verifyAccessLogIntegrity()).toMatchObject({ intact: true, entries: 0 });
  });
});
