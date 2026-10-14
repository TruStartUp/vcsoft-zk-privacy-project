import "./lib/load-env.js";

import { issuerNonce, nodeClient } from "./lib/chain.js";
import { reconcile } from "./lib/checks.js";
import { StressClient, type PartnerCredentials, type Reply } from "./lib/client.js";
import { readJson, readLocalDeployment, requireStressStores } from "./lib/env.js";
import { activate, newHolder, register, type Holder } from "./lib/holder.js";
import { startService, summarizeServiceLog } from "./lib/service.js";
import { heading, json, line, machine } from "./lib/stats.js";

const PER_INSTANCE = 10;

requireStressStores(process.env.DATABASE_URL!, process.env.REDIS_URL!);
machine();
const deployment = readLocalDeployment();
const partners = readJson<Record<string, PartnerCredentials>>("partners.json");
const domain = { chainId: deployment.chainId, credentialRegistry: deployment.credentialRegistry };
const node = nodeClient();

heading("Dos instancias de zk-api con la misma ISSUER_PRIVATE_KEY y la misma base de datos");
const a = await startService("s11-a", { API_PORT: "3071" });
const b = await startService("s11-b", { API_PORT: "3072" });
const platformA = new StressClient(a.url, partners.platform!);
const platformB = new StressClient(b.url, partners.platform!);

function tally(replies: Reply[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const reply of replies) {
    const reason = typeof reply.body?.details?.reason === "string" ? ` · ${reply.body.details.reason.slice(0, 100)}` : "";
    const key = `${reply.status}${reply.status >= 400 ? ` ${reply.body?.code}${reason}` : ""}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

async function registered(client: StressClient, count: number): Promise<Holder[]> {
  const out: Holder[] = [];
  for (let i = 0; i < count; i += 1) {
    const holder = await newHolder(170);
    if ((await register(client, holder)).status !== 201) throw new Error("register failed");
    out.push(holder);
  }
  return out;
}

const holdersA = await registered(platformA, PER_INSTANCE);
const holdersB = await registered(platformB, PER_INSTANCE);
const nonceBefore = await issuerNonce(node, deployment.issuer);
line(`A: ${PER_INSTANCE} activaciones · B: ${PER_INSTANCE} activaciones y ${PER_INSTANCE} cambios de jurisdicción en activos distintos, todo a la vez`);
const [activationsA, activationsB, jurisdictionsB] = await Promise.all([
  Promise.all(holdersA.map((h) => activate(platformA, h, domain))),
  Promise.all(holdersB.map((h) => activate(platformB, h, domain))),
  Promise.all(
    Array.from({ length: PER_INSTANCE }, (_, i) =>
      platformB.put(`/v1/assets/${7000 + i + Math.floor(Math.random() * 1_000_000) * 100}/jurisdictions`, { admitted: [170] }),
    ),
  ),
]);
json("activaciones en A", tally(activationsA));
json("activaciones en B", tally(activationsB));
json("jurisdicciones en B", tally(jurisdictionsB));
const ok = [...activationsA, ...activationsB].filter((r) => r.status === 201).length + jurisdictionsB.filter((r) => r.status === 200).length;
line(`escrituras con éxito ${ok}/${3 * PER_INSTANCE} · transacciones minadas ${(await issuerNonce(node, deployment.issuer)) - nonceBefore}`);
await reconcile(new StressClient(a.url, partners.operator!), "reconciliación");

await a.stop();
await b.stop();
heading("Registro de las dos instancias");
json("A", summarizeServiceLog(a.logPath));
json("B", summarizeServiceLog(b.logPath));
process.exit(0);
