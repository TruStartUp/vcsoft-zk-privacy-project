import "./lib/load-env.js";

import { StressClient, type PartnerCredentials } from "./lib/client.js";
import { hasJson, readJson, readLocalDeployment, requireStressStores, writeJson } from "./lib/env.js";
import { activate, newHolder, register, type Holder } from "./lib/holder.js";
import { serializeHolder, type StoredHolder } from "./lib/holders.js";
import { reconcile } from "./lib/checks.js";
import { startService, summarizeServiceLog } from "./lib/service.js";
import { formatSummary, heading, json, line, linearFit, machine, ms, summarize } from "./lib/stats.js";

const ASSET_ID = 42n;
const ADMITTED = [170, 484, 604, 152, 724];
const SERIAL_TARGET = Number(process.env.STRESS_SERIAL_TARGET ?? 1000);
const BATCHES = (process.env.STRESS_BATCHES ?? "10,50").split(",").map(Number);
const CHECKPOINTS = new Set([1, 100, 1000]);

requireStressStores(process.env.DATABASE_URL!, process.env.REDIS_URL!);
machine();
const deployment = readLocalDeployment();
const partners = readJson<Record<string, PartnerCredentials>>("partners.json");
const domain = { chainId: deployment.chainId, credentialRegistry: deployment.credentialRegistry };
const service = await startService("s4");
const platform = new StressClient(service.url, partners.platform!);
const operator = new StressClient(service.url, partners.operator!);
const holders: StoredHolder[] = SERIAL_TARGET === 0 && hasJson("holders.json") ? readJson<StoredHolder[]>("holders.json") : [];

if (SERIAL_TARGET > 0) {
  heading(`Jurisdicciones del activo ${ASSET_ID}`);
  const jurisdictions = await platform.put(`/v1/assets/${ASSET_ID}/jurisdictions`, { admitted: ADMITTED });
  line(`PUT jurisdicciones → ${jurisdictions.status} en ${ms(jurisdictions.ms)}`);
}

heading(`Fase 1 · emisión y activación en serie hasta ${SERIAL_TARGET} hojas`);
const serial: { leaves: number; registerMs: number; activateMs: number }[] = [];
const failures: Record<string, number> = {};
const started = performance.now();
for (let i = 0; i < SERIAL_TARGET; i += 1) {
  const holder = await newHolder(ADMITTED[i % ADMITTED.length]);
  const registered = await register(platform, holder);
  if (registered.status !== 201) {
    failures[`register ${registered.status} ${registered.body?.code}`] = (failures[`register ${registered.status} ${registered.body?.code}`] ?? 0) + 1;
    continue;
  }
  const activated = await activate(platform, holder, domain);
  if (activated.status !== 201) {
    failures[`activate ${activated.status} ${activated.body?.code}`] = (failures[`activate ${activated.status} ${activated.body?.code}`] ?? 0) + 1;
    continue;
  }
  holders.push(serializeHolder(holder));
  serial.push({ leaves: activated.body.leafIndex + 1, registerMs: registered.ms, activateMs: activated.ms });

  const leaves = serial.length;
  if (leaves % 100 === 0 || leaves === 1) {
    const window = serial.slice(-Math.min(100, leaves));
    line(
      `${leaves} hojas · últimas ${window.length}: alta ${formatSummary(summarize(window.map((s) => s.registerMs)))} | activación ${formatSummary(summarize(window.map((s) => s.activateMs)))}`,
    );
  }
  if (CHECKPOINTS.has(leaves)) await reconcile(operator, `reconciliación con ${leaves} hojas`);
}
line(`fase 1: ${serial.length} activaciones en ${((performance.now() - started) / 1000).toFixed(1)} s`);
json("fallos fase 1", failures);
if (SERIAL_TARGET > 0) writeJson("holders.json", holders);

const fit = serial.length > 1 ? linearFit(serial.map((s) => [s.leaves, s.activateMs])) : { intercept: Number.NaN, slope: Number.NaN, r2: Number.NaN };
line(
  `ajuste lineal de la activación frente a hojas: ${fit.intercept.toFixed(1)} ms + ${(fit.slope * 1000).toFixed(1)} ms por cada 1000 hojas (R² ${fit.r2.toFixed(3)})`,
);
for (const at of [1, 10, 100, 250, 500, 750, 1000].filter((n) => n <= serial.length)) {
  const around = serial.filter((s) => Math.abs(s.leaves - at) <= Math.max(2, at * 0.02));
  line(`  alrededor de ${at} hojas: activación ${formatSummary(summarize(around.map((s) => s.activateMs)))}`);
}

for (const size of BATCHES) {
  heading(`Fase 2 · lote concurrente de ${size} activaciones`);
  const batch: Holder[] = [];
  for (let i = 0; i < size; i += 1) {
    const holder = await newHolder(ADMITTED[i % ADMITTED.length]);
    const registered = await register(platform, holder);
    if (registered.status !== 201) throw new Error(`register answered ${registered.status}`);
    batch.push(holder);
  }
  const t0 = performance.now();
  const replies = await Promise.all(batch.map((holder) => activate(platform, holder, domain)));
  const wall = performance.now() - t0;
  const statuses: Record<string, number> = {};
  for (const reply of replies) {
    const key = `${reply.status}${reply.status >= 400 ? ` ${reply.body?.code}` : ""}`;
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  json("estados", statuses);
  const busy = replies.find((r) => r.status === 503);
  if (busy) json("ejemplo de rechazo por capacidad", { status: busy.status, code: busy.body?.code, details: busy.body?.details });
  line(`tiempo total del lote ${ms(wall)} · ${(wall / size).toFixed(1)} ms por activación · latencia ${formatSummary(summarize(replies.map((r) => r.ms)))}`);
  const indices = replies.filter((r) => r.status === 201).map((r) => r.body.leafIndex as number);
  line(`posiciones asignadas: ${indices.length}, distintas: ${new Set(indices).size}`);
  for (const [i, reply] of replies.entries()) if (reply.status === 201) holders.push(serializeHolder(batch[i]!));
  writeJson("holders.json", holders);
  await reconcile(operator, `reconciliación tras el lote de ${size}`);
}

heading("Coste del árbol en el proceso (misma base de datos)");
const { buildCredentialTree } = await import("../src/services/tree.service.js");
const timings: number[] = [];
let leafCount = 0;
for (let i = 0; i < 5; i += 1) {
  const t0 = performance.now();
  const tree = await buildCredentialTree();
  timings.push(performance.now() - t0);
  leafCount = tree.leafCount;
}
line(`buildCredentialTree con ${leafCount} hojas: ${formatSummary(summarize(timings))}`);

await service.stop();
heading("Registro del servicio");
json("resumen", summarizeServiceLog(service.logPath));
process.exit(0);
