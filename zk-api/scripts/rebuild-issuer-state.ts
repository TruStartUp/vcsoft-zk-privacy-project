import { prisma } from "../src/lib/prisma.js";
import { reconcileIssuerState } from "../src/services/tree.service.js";

const assetIds = process.argv.slice(2);

const result = await reconcileIssuerState(assetIds);
process.stdout.write(`${JSON.stringify({ credentialTree: result.credentialTree }, null, 2)}\n`);
for (const { assetId, jurisdictionTree } of result.jurisdictionTrees) {
  process.stdout.write(`${JSON.stringify({ assetId, jurisdictionTree }, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify({ healthy: result.problems.length === 0, problems: result.problems }, null, 2)}\n`);

await prisma.$disconnect();
process.exit(result.problems.length === 0 ? 0 : 1);
