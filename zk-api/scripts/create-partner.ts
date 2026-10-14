import { SCOPES, createPartner, type Scope } from "../src/services/partner.service.js";
import { prisma } from "../src/lib/prisma.js";

const [name, ...requested] = process.argv.slice(2);

if (!name || requested.length === 0) {
  process.stderr.write(`usage: npm run partner:create -- <name> <scope...>\nscopes: ${SCOPES.join(", ")}\n`);
  process.exit(1);
}

const unknown = requested.filter((scope) => !SCOPES.includes(scope as Scope));
if (unknown.length > 0) {
  process.stderr.write(`unknown scopes: ${unknown.join(", ")}\n`);
  process.exit(1);
}

const partner = await createPartner(name, requested as Scope[]);
process.stdout.write(`${JSON.stringify(partner, null, 2)}\n`);
process.stdout.write("\nThe secret is shown once. Store it with the partner now.\n");
await prisma.$disconnect();
