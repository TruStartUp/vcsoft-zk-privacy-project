import { prisma } from "../../src/lib/prisma.js";
import { flushAccessLog } from "../../src/middleware/access-log.js";
import { redis } from "../../src/lib/redis.js";

/// The access log refuses DELETE, so a reset truncates it with the trigger
/// disabled: the guarantee under test is that the application cannot rewrite
/// history, not that a superuser cannot drop the table.
export async function resetDatabase(): Promise<void> {
  await flushAccessLog();
  await prisma.$executeRawUnsafe("ALTER TABLE access_log_entries DISABLE TRIGGER USER");
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE access_log_entries, disclosure_requests, proof_verifications,
     identity_envelopes, credentials, jurisdiction_leaves, root_publications,
     indexer_cursors, partners RESTART IDENTITY CASCADE`,
  );
  await prisma.$executeRawUnsafe("ALTER TABLE access_log_entries ENABLE TRIGGER USER");
  await redis().flushdb();
}
