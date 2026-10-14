import { createHmac } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

export interface ChainedFields {
  sequence: bigint;
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
  occurredAt: Date;
}

/// The bytes that are chained. Field order is fixed here and nowhere else, so an
/// entry written today still verifies after the model grows a column.
function canonical(entry: ChainedFields): string {
  return JSON.stringify([
    entry.sequence.toString(),
    entry.partnerKey,
    entry.actorRef ?? "",
    entry.method,
    entry.path,
    entry.scope ?? "",
    entry.resourceType,
    entry.resourceId ?? "",
    entry.outcome,
    entry.statusCode,
    entry.requestDigest,
    entry.occurredAt.toISOString(),
  ]);
}

/// Keyed rather than plain: a hash chain alone is only tamper-evident against
/// someone who cannot recompute it, and whoever can write the table can. The key
/// lives in configuration, so rewriting history needs the secret manager too.
export function chainEntry(key: Buffer, entry: ChainedFields, previousHash: string): string {
  return createHmac("sha256", key).update(`${previousHash}\n${canonical(entry)}`, "utf8").digest("hex");
}

export interface ChainVerification {
  intact: boolean;
  checked: number;
  brokenAtSequence?: bigint;
  reason?: "hash_mismatch" | "predecessor_mismatch" | "sequence_gap";
}

export function verifyChain(
  key: Buffer,
  entries: (ChainedFields & { previousHash: string; entryHash: string })[],
  expectedFirstPreviousHash = GENESIS_HASH,
): ChainVerification {
  let previousHash = expectedFirstPreviousHash;
  let expectedSequence: bigint | undefined;

  for (const [index, entry] of entries.entries()) {
    expectedSequence ??= entry.sequence;
    if (entry.sequence !== expectedSequence) {
      return { intact: false, checked: index, brokenAtSequence: entry.sequence, reason: "sequence_gap" };
    }
    if (entry.previousHash !== previousHash) {
      return { intact: false, checked: index, brokenAtSequence: entry.sequence, reason: "predecessor_mismatch" };
    }
    if (chainEntry(key, entry, previousHash) !== entry.entryHash) {
      return { intact: false, checked: index, brokenAtSequence: entry.sequence, reason: "hash_mismatch" };
    }
    previousHash = entry.entryHash;
    expectedSequence += 1n;
  }

  return { intact: true, checked: entries.length };
}
