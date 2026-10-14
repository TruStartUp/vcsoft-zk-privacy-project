import "./lib/load-env.js";

import { issuerNonce, leafEvents, nodeClient } from "./lib/chain.js";
import { reconcile, rootChain } from "./lib/checks.js";
import { StressClient, type PartnerCredentials, type Reply } from "./lib/client.js";
import { readJson, readLocalDeployment, requireStressStores, writeJson } from "./lib/env.js";
import { activate, newHolder, register, type Holder } from "./lib/holder.js";
import { serializeHolder, type StoredHolder } from "./lib/holders.js";
import { startService, summarizeServiceLog } from "./lib/service.js";
import { formatSummary, heading, json, line, machine, summarize } from "./lib/stats.js";

const ROUNDS = (process.env.STRESS_ROUNDS ?? "20,100").split(",").map(Number);
const CROSS_ASSETS = 20;
const CROSS_ACTIVATIONS = 10;

requireStressStores(process.env.DATABASE_URL!, process.env.REDIS_URL!);
machine();
const deployment = readLocalDeployment();
const partners = readJson<Record<string, PartnerCredentials>>("partners.json");
const stored = readJson<StoredHolder[]>("holders.json");
const domain = { chainId: deployment.chainId, credentialRegistry: deployment.credentialRegistry };
const node = nodeClient();
const fromBlock = BigInt(deployment.deploymentBlock);

const service = await startService("s10", { ISSUER_WRITE_QUEUE_LIMIT: "200" });
line("ISSUER_WRITE_QUEUE_LIMIT=200 para que todas las escrituras de cada ronda entren a la vez en la cola");
const platform = new StressClient(service.url, partners.platform!);
const operator = new StressClient(service.url, partners.operator!);

function tally(replies: Reply[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const reply of replies) {
    const reason = typeof reply.body?.details?.reason === "string" ? ` · ${reply.body.details.reason.slice(0, 120)}` : "";
    const key = `${reply.status}${reply.status >= 400 ? ` ${reply.body?.code}${reason}` : ""}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function nonceTrouble(replies: Reply[]): number {
  return replies.filter((r) => /nonce/i.test(JSON.stringify(r.body ?? ""))).length;
}

async function registered(count: number): Promise<Holder[]> {
  const out: Holder[] = [];
  for (let i = 0; i < count; i += 1) {
    const holder = await newHolder(170);
    const reply = await register(platform, holder);
    if (reply.status !== 201) throw new Error(`register answered ${reply.status}`);
    out.push(holder);
  }
  return out;
}

let revocable = stored.filter((h) => !h.revoked && h.leafIndex > 0).reverse();

for (const size of ROUNDS) {
  heading(`Ronda de ${size} escrituras concurrentes: ${size / 2} activaciones y ${size / 2} revocaciones (cerrando la ventana)`);
  const fresh = await registered(size / 2);
  const targets = revocable.slice(0, size / 2);
  revocable = revocable.slice(size / 2);
  const nonceBefore = await issuerNonce(node, deployment.issuer);
  const eventsBefore = (await leafEvents(node, deployment.credentialRegistry, fromBlock)).length;

  const t0 = performance.now();
  const [activations, revocations] = await Promise.all([
    Promise.all(fresh.map((holder) => activate(platform, holder, domain))),
    Promise.all(targets.map((target) => platform.post(`/v1/credentials/${target.commitment}/revocation`, { closeRootWindow: true }))),
  ]);
  const wall = performance.now() - t0;

  json("activaciones", tally(activations));
  json("revocaciones", tally(revocations));
  line(`tiempo total ${(wall / 1000).toFixed(1)} s · latencia activación ${formatSummary(summarize(activations.map((r) => r.ms)))}`);
  line(`latencia revocación ${formatSummary(summarize(revocations.map((r) => r.ms)))}`);
  const okActivations = activations.filter((r) => r.status === 201).length;
  const okRevocations = revocations.filter((r) => r.status === 200);
  const invalidations = okRevocations.filter((r) => r.body?.previousRootInvalidated).length;
  const mined = (await issuerNonce(node, deployment.issuer)) - nonceBefore;
  line(
    `transacciones minadas ${mined} · esperadas ${okActivations + okRevocations.length + invalidations} (${okActivations} publicaciones por activación, ${okRevocations.length} por revocación, ${invalidations} invalidaciones) · eventos de hoja nuevos ${(await leafEvents(node, deployment.credentialRegistry, fromBlock)).length - eventsBefore}`,
  );
  line(`respuestas que mencionan el nonce: ${nonceTrouble([...activations, ...revocations])}`);

  for (const [i, reply] of activations.entries()) if (reply.status === 201) stored.push(serializeHolder(fresh[i]!));
  for (const [i, reply] of revocations.entries()) {
    if (reply.status === 200) {
      const entry = stored.find((h) => h.commitment === targets[i]!.commitment);
      if (entry) entry.revoked = true;
    }
  }
  writeJson("holders.json", stored);
  await rootChain();
  await reconcile(operator, `reconciliación tras la ronda de ${size}`);
}

heading(`Cruce de bloqueos: ${CROSS_ASSETS} cambios de jurisdicción en activos distintos y ${CROSS_ACTIVATIONS} activaciones a la vez`);
const crossHolders = await registered(CROSS_ACTIVATIONS);
const nonceBefore = await issuerNonce(node, deployment.issuer);
const t0 = performance.now();
const [jurisdictions, crossActivations] = await Promise.all([
  Promise.all(
    Array.from({ length: CROSS_ASSETS }, (_, i) =>
      platform.put(`/v1/assets/${5000 + i + Math.floor(Math.random() * 1_000_000) * 100}/jurisdictions`, { admitted: [170, 484] }),
    ),
  ),
  Promise.all(crossHolders.map((holder) => activate(platform, holder, domain))),
]);
json("jurisdicciones", tally(jurisdictions));
json("activaciones", tally(crossActivations));
line(`tiempo total ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const okWrites = jurisdictions.filter((r) => r.status === 200).length + crossActivations.filter((r) => r.status === 201).length;
line(`transacciones minadas ${(await issuerNonce(node, deployment.issuer)) - nonceBefore} · escrituras con éxito ${okWrites}`);
line(`respuestas que mencionan el nonce: ${nonceTrouble([...jurisdictions, ...crossActivations])}`);
for (const [i, reply] of crossActivations.entries()) if (reply.status === 201) stored.push(serializeHolder(crossHolders[i]!));
writeJson("holders.json", stored);
await rootChain();
await reconcile(operator, "reconciliación tras el cruce de bloqueos");

await service.stop();
heading("Registro del servicio");
json("resumen", summarizeServiceLog(service.logPath));
process.exit(0);
