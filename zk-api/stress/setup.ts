import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";
import { parse } from "dotenv";

import {
  API_DIR,
  ENV_FILE,
  LOCAL_RPC_URL,
  REPO_DIR,
  STRESS_DATABASE,
  applyEnvFile,
  readLocalDeployment,
  requireStressStores,
  writeJson,
  writeStressEnv,
} from "./lib/env.js";
import { heading, json, line, machine } from "./lib/stats.js";

const PARTNERS = {
  platform: ["credentials:issue", "credentials:activate", "credentials:revoke", "credentials:read", "credentials:opening", "jurisdictions:write"],
  bank: ["proofs:verify", "proofs:read", "compliance:read", "credentials:read"],
  audit: ["audit:read"],
  operator: ["issuer:admin"],
} as const;

machine();

heading("Contratos nuevos en el nodo local (puerto 8565)");
const chainId = await fetch(LOCAL_RPC_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
}).then((r) => r.json() as Promise<{ result: string }>);
if (Number(chainId.result) !== 31337) throw new Error(`the node on 8565 is chain ${Number(chainId.result)}, not a local Hardhat node`);
execFileSync("npx", ["hardhat", "run", "stress/deploy-local.ts", "--network", "localhost"], {
  cwd: resolve(REPO_DIR, "zk-contracts"),
  stdio: "inherit",
});
const deployment = readLocalDeployment();

heading(`Entorno ${ENV_FILE}: base de datos ${STRESS_DATABASE}, Redis 2, claves nuevas`);
writeStressEnv(deployment);
process.env.DOTENV_CONFIG_PATH = ENV_FILE;
const stressEnv = applyEnvFile(ENV_FILE);
requireStressStores(stressEnv.DATABASE_URL!, stressEnv.REDIS_URL!);
const baseEnv = parse(readFileSync(resolve(API_DIR, ".env")));

const admin = new PrismaClient({ datasources: { db: { url: baseEnv.DATABASE_URL! } } });
const exists = await admin.$queryRawUnsafe<{ count: bigint }[]>(
  `SELECT count(*)::bigint AS count FROM pg_database WHERE datname = '${STRESS_DATABASE}'`,
);
if (Number(exists[0]!.count) === 0) {
  await admin.$executeRawUnsafe(`CREATE DATABASE ${STRESS_DATABASE}`);
  line(`base de datos ${STRESS_DATABASE} creada`);
}
await admin.$disconnect();

execFileSync("npx", ["prisma", "migrate", "deploy"], {
  cwd: API_DIR,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: stressEnv.DATABASE_URL },
});

const { resetDatabase } = await import("../test/helpers/database.js");
const { createPartner } = await import("../src/services/partner.service.js");
const { prisma } = await import("../src/lib/prisma.js");
const { closeRedis } = await import("../src/lib/redis.js");
const { config } = await import("../src/config/index.js");
requireStressStores(config.databaseUrl, config.redisUrl);

await resetDatabase();
line(`${STRESS_DATABASE} vaciada y Redis 2 limpio`);

heading("Socios de estrés");
const partners: Record<string, { partnerKey: string; secret: string; scopes: readonly string[] }> = {};
for (const [name, scopes] of Object.entries(PARTNERS)) {
  const created = await createPartner(`stress-${name}`, [...scopes]);
  partners[name] = { partnerKey: created.partnerKey, secret: created.secret, scopes };
  line(`socio ${name}: ${created.partnerKey} · ${scopes.join(" ")}`);
}
writeJson("partners.json", partners);
json("despliegue", deployment);

await prisma.$disconnect();
await closeRedis();
