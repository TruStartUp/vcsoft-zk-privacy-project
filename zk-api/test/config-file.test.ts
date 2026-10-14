import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const tsx = join(root, "node_modules", ".bin", "tsx");
const workdir = mkdtempSync(join(tmpdir(), "zk-api-config-"));
const key = Buffer.alloc(32, 7).toString("base64");

function environmentFile(port: number, chainId: number): string {
  return [
    "NODE_ENV=development",
    "LOG_LEVEL=silent",
    `API_PORT=${port}`,
    "DATABASE_URL=postgresql://u:p@127.0.0.1:1/db",
    "REDIS_URL=redis://127.0.0.1:1",
    "CHAIN_RPC_URL=http://127.0.0.1:1",
    `CHAIN_ID=${chainId}`,
    `CREDENTIAL_REGISTRY_ADDRESS=0x${"1".repeat(40)}`,
    `COMPLIANCE_ATTESTOR_ADDRESS=0x${"2".repeat(40)}`,
    "REGISTRY_DEPLOYMENT_BLOCK=0",
    `ISSUER_PRIVATE_KEY=0x${"3".repeat(64)}`,
    "PROOF_SCHEME=groth16",
    "PROOF_VERIFICATION_KEY_PATH=unused",
    `SUBJECT_REFERENCE_KEY=${key}`,
    `DISCLOSURE_VIEWING_KEYS=vk-a:${key}`,
    "DISCLOSURE_ACTIVE_VIEWING_KEY=vk-a",
    `PARTNER_SECRET_ENCRYPTION_KEY=${key}`,
    "PARTNER_SIGNATURE_WINDOW_SECONDS=300",
    `ACCESS_LOG_HMAC_KEY=${key}`,
    "",
  ].join("\n");
}

const probe = join(workdir, "probe.mts");
writeFileSync(
  probe,
  `const { config } = await import(${JSON.stringify(join(root, "src", "config", "index.ts"))});\n` +
    "process.stdout.write(JSON.stringify({ port: config.apiPort, chainId: config.chain.chainId }));\n",
);

function loadedFrom(cwd: string, extra: Record<string, string> = {}): { port: number; chainId: number } {
  const output = execFileSync(tsx, [probe], { cwd, env: { PATH: process.env.PATH ?? "", ...extra }, encoding: "utf8" });
  return JSON.parse(output) as { port: number; chainId: number };
}

afterAll(() => rmSync(workdir, { recursive: true, force: true }));

describe("environment file", () => {
  it("reads .env from the working directory by default", () => {
    writeFileSync(join(workdir, ".env"), environmentFile(4101, 31337));
    expect(loadedFrom(workdir)).toEqual({ port: 4101, chainId: 31337 });
  });

  it("reads the file DOTENV_CONFIG_PATH names instead, and nothing from .env", () => {
    writeFileSync(join(workdir, ".env"), environmentFile(4101, 31337));
    writeFileSync(join(workdir, ".env.testnet"), environmentFile(4102, 84532));
    expect(loadedFrom(workdir, { DOTENV_CONFIG_PATH: ".env.testnet" })).toEqual({ port: 4102, chainId: 84532 });
  });
});
