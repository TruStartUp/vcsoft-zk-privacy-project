import "./lib/load-env.js";

import { integrity, reconcile } from "./lib/checks.js";
import { StressClient, type PartnerCredentials } from "./lib/client.js";
import { tableCounts } from "./lib/db.js";
import { readJson, requireStressStores } from "./lib/env.js";
import { startService, summarizeServiceLog } from "./lib/service.js";
import { heading, json, line, machine } from "./lib/stats.js";

requireStressStores(process.env.DATABASE_URL!, process.env.REDIS_URL!);
machine();
const partners = readJson<Record<string, PartnerCredentials>>("partners.json");
const service = await startService("s5");
const audit = new StressClient(service.url, partners.audit!);
const operator = new StressClient(service.url, partners.operator!);

heading("Estado acumulado tras S1–S4, S10 y S12");
const counts = await tableCounts();
json("filas", counts);
line(`secuencia más alta ${counts.lastSequence} · filas ${counts.accessLog} · huecos ${counts.lastSequence - counts.accessLog}`);

heading("Integridad del registro de accesos (tres lecturas)");
const rss: number[] = [];
for (let i = 1; i <= 3; i += 1) {
  const sampler = setInterval(() => rss.push(service.rssMiB()), 200);
  const reply = await integrity(audit, `lectura ${i}`);
  clearInterval(sampler);
  if (reply.status === 200 && reply.body.entries > 0) line(`  ${((1000 * reply.ms) / reply.body.entries).toFixed(1)} µs por entrada`);
}
line(`RSS máximo del servicio durante las lecturas ${Math.max(...rss).toFixed(0)} MiB`);

heading("Reconciliación de credenciales");
await reconcile(operator, "estado final");

await service.stop();
heading("Registro del servicio");
json("resumen", summarizeServiceLog(service.logPath));
process.exit(0);
