import "./lib/load-env.js";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "dotenv";

import { StressClient, type PartnerCredentials } from "./lib/client.js";
import { REPO_DIR } from "./lib/env.js";
import { startService, summarizeServiceLog } from "./lib/service.js";
import { heading, json, line, machine, ms } from "./lib/stats.js";

const chainEnv = parse(readFileSync(resolve(REPO_DIR, "zk-contracts/.env")));
const secrets = [chainEnv.BASE_SEPOLIA_RPC_URL, process.env.CHAIN_RPC_URL, chainEnv.PLATFORM_PRIVATE_KEY, process.env.ISSUER_PRIVATE_KEY]
  .filter((value): value is string => typeof value === "string" && value.length >= 8)
  .flatMap((value) => [value, value.replace(/^0x/, "")]);
const redact = (text: string) => secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    write(typeof chunk === "string" ? redact(chunk) : redact(Buffer.from(chunk).toString("utf8")), ...rest)) as typeof stream.write;
}

const e2e = JSON.parse(readFileSync(resolve(REPO_DIR, "zk-holder/e2e/state/base-sepolia.json"), "utf8")) as {
  partners: Record<string, PartnerCredentials>;
};
const deployment = JSON.parse(readFileSync(resolve(REPO_DIR, "zk-contracts/deployments/baseSepolia.json"), "utf8")) as {
  parameters: { assetId: string };
};
const overrides = Object.fromEntries(
  (process.env.STRESS_OVERRIDES ?? "").split(",").filter(Boolean).map((pair) => pair.split("=") as [string, string]),
);

machine();
heading("Reconciliación de Base Sepolia tras S13");
json("ajustes", overrides);
const service = await startService("s13-reconcile", { DOTENV_CONFIG_PATH: ".env.testnet", API_PORT: "3073", ...overrides });
const operator = new StressClient(service.url, e2e.partners.operator!);
const audit = new StressClient(service.url, e2e.partners.audit!);
const credentials = await operator.post("/v1/issuer/state/rebuild");
json(`credenciales ${credentials.status} en ${ms(credentials.ms)}`, credentials.status === 200 ? { ...credentials.body, missingFromDatabase: credentials.body.missingFromDatabase.length, missingFromChain: credentials.body.missingFromChain.length } : credentials.body);
const asset = await operator.post(`/v1/issuer/assets/${deployment.parameters.assetId}/state/rebuild`);
json(`jurisdicciones ${asset.status} en ${ms(asset.ms)}`, asset.body);
const integrity = await audit.get("/v1/access-log/integrity");
json(`registro de accesos ${integrity.status}`, integrity.body);
await service.stop();
line();
json("registro del servicio", summarizeServiceLog(service.logPath));
process.exit(0);
