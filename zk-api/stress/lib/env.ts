import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "dotenv";

export const API_DIR = resolve(import.meta.dirname, "../..");
export const REPO_DIR = resolve(API_DIR, "..");
export const OUT_DIR = resolve(API_DIR, "stress/out");
export const ENV_FILE = ".env.stress";
export const STRESS_DATABASE = "zkapi_stress";
export const STRESS_REDIS_DB = 2;
export const STRESS_API_PORT = 3071;
export const LOCAL_RPC_URL = "http://127.0.0.1:8565";
// Hardhat's well-known account #1: a public development key, never funded anywhere real.
export const LOCAL_ISSUER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export interface LocalDeployment {
  chainId: number;
  deploymentBlock: number;
  credentialRegistry: `0x${string}`;
  complianceAttestor: `0x${string}`;
  groth16VerifierAdapter: `0x${string}`;
  admin: `0x${string}`;
  issuer: `0x${string}`;
}

export function readLocalDeployment(): LocalDeployment {
  const path = resolve(REPO_DIR, "zk-contracts/stress/out/localhost.json");
  if (!existsSync(path)) throw new Error("deploy the stress stack first: npm run stress:deploy in zk-contracts");
  return JSON.parse(readFileSync(path, "utf8")) as LocalDeployment;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withRedisDb(url: string, db: number): string {
  const parsed = new URL(url);
  parsed.pathname = `/${db}`;
  return parsed.toString();
}

/// Derives the stress environment from the development one: same PostgreSQL and
/// Redis servers, its own database and Redis index, fresh keys, the local node.
export function writeStressEnv(deployment: LocalDeployment): void {
  const base = parse(readFileSync(resolve(API_DIR, ".env")));
  if (!base.DATABASE_URL || !base.REDIS_URL) throw new Error(".env lacks DATABASE_URL or REDIS_URL");
  const viewing = generateKeyPairSync("x25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(16);
  const key = () => randomBytes(32).toString("base64");

  const lines = [
    "NODE_ENV=production",
    "LOG_LEVEL=info",
    `API_PORT=${STRESS_API_PORT}`,
    `DATABASE_URL=${withDatabase(base.DATABASE_URL, STRESS_DATABASE)}`,
    `REDIS_URL=${withRedisDb(base.REDIS_URL, STRESS_REDIS_DB)}`,
    `CHAIN_RPC_URL=${LOCAL_RPC_URL}`,
    `CHAIN_ID=${deployment.chainId}`,
    `CREDENTIAL_REGISTRY_ADDRESS=${deployment.credentialRegistry}`,
    `COMPLIANCE_ATTESTOR_ADDRESS=${deployment.complianceAttestor}`,
    `REGISTRY_DEPLOYMENT_BLOCK=${deployment.deploymentBlock}`,
    `ISSUER_PRIVATE_KEY=${LOCAL_ISSUER_KEY}`,
    "CHAIN_CONFIRMATIONS=1",
    "CHAIN_POLLING_INTERVAL_MS=100",
    "PROOF_SCHEME=groth16",
    "PROOF_VERIFICATION_KEY_PATH=../zk-circuits/build/groth16.vkey.json",
    `SUBJECT_REFERENCE_KEY=${key()}`,
    `DISCLOSURE_VIEWING_KEYS=vk-stress:${viewing.toString("base64")}`,
    "DISCLOSURE_ACTIVE_VIEWING_KEY=vk-stress",
    `PARTNER_SECRET_ENCRYPTION_KEY=${key()}`,
    "PARTNER_SIGNATURE_WINDOW_SECONDS=300",
    `ACCESS_LOG_HMAC_KEY=${key()}`,
    "",
  ];
  writeFileSync(resolve(API_DIR, ENV_FILE), lines.join("\n"), { mode: 0o600 });
}

export function applyEnvFile(file: string): Record<string, string> {
  const values = parse(readFileSync(resolve(API_DIR, file)));
  Object.assign(process.env, values);
  return values;
}

/// Refuses to touch anything but the stress database and Redis index.
export function requireStressStores(databaseUrl: string, redisUrl: string): void {
  if (new URL(databaseUrl).pathname !== `/${STRESS_DATABASE}`) throw new Error(`refusing to run against ${new URL(databaseUrl).pathname}`);
  if (new URL(redisUrl).pathname !== `/${STRESS_REDIS_DB}`) throw new Error(`refusing to run against Redis ${new URL(redisUrl).pathname}`);
}

export function ensureOutDir(): string {
  mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

export function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(OUT_DIR, name), "utf8")) as T;
}

export function writeJson(name: string, value: unknown): void {
  ensureOutDir();
  writeFileSync(resolve(OUT_DIR, name), `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`, {
    mode: 0o600,
  });
}

export function hasJson(name: string): boolean {
  return existsSync(resolve(OUT_DIR, name));
}
