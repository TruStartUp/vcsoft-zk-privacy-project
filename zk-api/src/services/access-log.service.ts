import { config } from "../config/index.js";
import { GENESIS_HASH, chainEntry, verifyChain, type ChainVerification, type ChainedFields } from "../lib/hash-chain.js";
import { prisma } from "../lib/prisma.js";

export interface AccessRecord {
  partnerId: string | null;
  partnerKey: string;
  actorRef: string | null;
  method: string;
  path: string;
  scope: string | null;
  resourceType: string;
  resourceId: string | null;
  outcome: string;
  statusCode: number;
  requestDigest: string;
  occurredAt?: Date;
}

/// Appends entries in the order given, each chained to the one before it.
///
/// The sequence number and the predecessor's hash are read under a lock inside
/// the same transaction as the insert, so two concurrent writers cannot both
/// chain onto the same predecessor and leave a fork nobody can verify.
export async function recordAccessBatch(records: AccessRecord[]): Promise<{ sequence: bigint; entryHash: string }[]> {
  if (records.length === 0) return [];
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(8140301)");

      const previous = await tx.accessLogEntry.findFirst({
        orderBy: { sequence: "desc" },
        select: { sequence: true, entryHash: true },
      });

      let sequence = previous?.sequence ?? 0n;
      let previousHash = previous?.entryHash ?? GENESIS_HASH;
      const rows = records.map((record) => {
        sequence += 1n;
        const occurredAt = record.occurredAt ?? new Date();
        const fields: ChainedFields = {
          sequence,
          partnerKey: record.partnerKey,
          actorRef: record.actorRef,
          method: record.method,
          path: record.path,
          scope: record.scope,
          resourceType: record.resourceType,
          resourceId: record.resourceId,
          outcome: record.outcome,
          statusCode: record.statusCode,
          requestDigest: record.requestDigest,
          occurredAt,
        };
        const entryHash = chainEntry(config.accessLogHmacKey, fields, previousHash);
        const row = { ...fields, partnerId: record.partnerId, previousHash, entryHash };
        previousHash = entryHash;
        return row;
      });

      await tx.accessLogEntry.createMany({ data: rows });
      return rows.map((row) => ({ sequence: row.sequence, entryHash: row.entryHash }));
    },
    { maxWait: 30_000, timeout: 60_000 },
  );
}

export async function recordAccess(record: AccessRecord): Promise<{ sequence: bigint; entryHash: string }> {
  const [entry] = await recordAccessBatch([record]);
  return entry!;
}

export interface AccessLogQuery {
  partnerKey?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: string;
}

export async function queryAccessLog(query: AccessLogQuery) {
  const entries = await prisma.accessLogEntry.findMany({
    where: {
      ...(query.partnerKey ? { partnerKey: query.partnerKey } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.from || query.to
        ? { occurredAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
      ...(query.cursor ? { sequence: { lt: BigInt(query.cursor) } } : {}),
    },
    orderBy: { sequence: "desc" },
    take: query.limit,
  });

  return {
    entries: entries.map((entry) => ({
      sequence: entry.sequence.toString(),
      occurredAt: entry.occurredAt.toISOString(),
      partnerKey: entry.partnerKey,
      actorRef: entry.actorRef,
      method: entry.method,
      path: entry.path,
      scope: entry.scope,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      outcome: entry.outcome,
      statusCode: entry.statusCode,
      requestDigest: entry.requestDigest,
      previousHash: entry.previousHash,
      entryHash: entry.entryHash,
    })),
    nextCursor: entries.length === query.limit ? entries[entries.length - 1]!.sequence.toString() : null,
  };
}

/// Walks the chain from the beginning and reports the first entry that does not
/// hash to what it claims. A row edited in place, a row removed, or a row
/// inserted without the key all show up here.
///
/// It reads the log a page at a time, carrying the last hash and sequence across
/// pages: loaded whole, half a million entries took the service past 5 GB.
export async function verifyAccessLogIntegrity(pageSize = 10_000): Promise<ChainVerification & { entries: number }> {
  const total = () => prisma.accessLogEntry.count();
  let previousHash = GENESIS_HASH;
  let lastSequence = 0n;
  let checked = 0;

  for (;;) {
    const page = await prisma.accessLogEntry.findMany({
      where: { sequence: { gt: lastSequence } },
      orderBy: { sequence: "asc" },
      take: pageSize,
    });
    if (page.length === 0) return { intact: true, checked, entries: await total() };

    if (page[0]!.sequence !== lastSequence + 1n) {
      return { intact: false, checked, reason: "sequence_gap", brokenAtSequence: page[0]!.sequence, entries: await total() };
    }

    const verification = verifyChain(
      config.accessLogHmacKey,
      page.map((entry) => ({
        sequence: entry.sequence,
        partnerKey: entry.partnerKey,
        actorRef: entry.actorRef,
        method: entry.method,
        path: entry.path,
        scope: entry.scope,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        outcome: entry.outcome,
        statusCode: entry.statusCode,
        requestDigest: entry.requestDigest,
        occurredAt: entry.occurredAt,
        previousHash: entry.previousHash,
        entryHash: entry.entryHash,
      })),
      previousHash,
    );
    if (!verification.intact) return { ...verification, checked: checked + verification.checked, entries: await total() };

    checked += page.length;
    previousHash = page[page.length - 1]!.entryHash;
    lastSequence = page[page.length - 1]!.sequence;
  }
}
