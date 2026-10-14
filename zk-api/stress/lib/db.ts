import { requireStressStores } from "./env.js";

export interface TableCounts {
  credentials: number;
  activeInTree: number;
  rootPublications: number;
  proofVerifications: number;
  accessLog: number;
  lastSequence: number;
}

async function client() {
  const { config } = await import("../../src/config/index.js");
  requireStressStores(config.databaseUrl, config.redisUrl);
  return (await import("../../src/lib/prisma.js")).prisma;
}

export async function tableCounts(): Promise<TableCounts> {
  const prisma = await client();
  const last = await prisma.accessLogEntry.findFirst({ orderBy: { sequence: "desc" }, select: { sequence: true } });
  return {
    credentials: await prisma.credential.count(),
    activeInTree: await prisma.credential.count({ where: { inTree: true } }),
    rootPublications: await prisma.rootPublication.count(),
    proofVerifications: await prisma.proofVerification.count(),
    accessLog: await prisma.accessLogEntry.count(),
    lastSequence: Number(last?.sequence ?? 0n),
  };
}

export async function stressPrisma() {
  return client();
}
