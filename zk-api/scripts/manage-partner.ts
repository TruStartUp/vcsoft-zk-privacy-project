import type { PartnerStatus } from "@prisma/client";

import { prisma } from "../src/lib/prisma.js";
import { listPartners, rotatePartnerSecret, setPartnerStatus } from "../src/services/partner.service.js";

const USAGE = "usage: manage-partner.ts list | suspend <partnerKey> | reactivate <partnerKey> | rotate-secret <partnerKey>\n";

const [action = "", partnerKey] = process.argv.slice(2);
const statusFor: Record<string, PartnerStatus> = { suspend: "SUSPENDED", reactivate: "ACTIVE" };

async function run(): Promise<number> {
  if (action === "list") {
    process.stdout.write(`${JSON.stringify(await listPartners(), null, 2)}\n`);
    return 0;
  }
  const status = statusFor[action];
  if (!partnerKey || (status === undefined && action !== "rotate-secret")) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (action === "rotate-secret") {
    process.stdout.write(`${JSON.stringify(await rotatePartnerSecret(partnerKey), null, 2)}\n`);
    process.stdout.write("\nThe new secret is shown once and the old one no longer verifies. Hand it to the partner now.\n");
    return 0;
  }
  process.stdout.write(`${JSON.stringify(await setPartnerStatus(partnerKey, status!), null, 2)}\n`);
  return 0;
}

let code: number;
try {
  code = await run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  code = 1;
}
await prisma.$disconnect();
process.exit(code);
