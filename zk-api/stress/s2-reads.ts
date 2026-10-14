import "./lib/load-env.js";

import { privateKeyToAccount } from "viem/accounts";

import { type PartnerCredentials } from "./lib/client.js";
import { tableCounts } from "./lib/db.js";
import { readJson, requireStressStores } from "./lib/env.js";
import { type StoredHolder } from "./lib/holders.js";
import { runLoad, type LoadResult } from "./lib/load.js";
import { startService, summarizeServiceLog } from "./lib/service.js";
import { heading, json, line, machine, ms, sleep } from "./lib/stats.js";

const ASSET_ID = 42n;
const DURATION = Number(process.env.STRESS_DURATION ?? 60);
const CONCURRENCY = [1, 16, 64];
const OPENING_CONCURRENCY = [1, 4];
const OPENING_DURATION = Number(process.env.STRESS_OPENING_DURATION ?? 30);

requireStressStores(process.env.DATABASE_URL!, process.env.REDIS_URL!);
machine();
const partners = readJson<Record<string, PartnerCredentials>>("partners.json");
const holders = readJson<StoredHolder[]>("holders.json");
const subjects = holders.map((h) => privateKeyToAccount(h.privateKey).address);
const commitments = holders.map((h) => h.commitment);
let cursor = 0;
const next = <T>(list: T[]) => list[cursor++ % list.length]!;

const service = await startService("s2");
const before = await tableCounts();
json("filas antes", before);
line(`${holders.length} titulares; las rutas se recorren en rueda sobre todos ellos`);

const results: LoadResult[] = [];
const routes = [
  { title: "GET /v1/compliance/assets/42/subjects/:subject", path: () => `/v1/compliance/assets/${ASSET_ID}/subjects/${next(subjects)}` },
  { title: "GET /v1/credentials/:commitment", path: () => `/v1/credentials/${next(commitments)}` },
];

for (const route of routes) {
  heading(route.title);
  for (const connections of CONCURRENCY) {
    const codes: Record<string, number> = {};
    const result = await runLoad({
      url: service.url,
      title: route.title,
      connections,
      durationSeconds: DURATION,
      method: "GET",
      path: route.path,
      credentials: partners.bank!,
      inspect: (status, body) => {
        if (status >= 400) {
          const code = (() => {
            try {
              return (JSON.parse(body) as { code?: string }).code;
            } catch {
              return "no-json";
            }
          })();
          codes[`${status} ${code}`] = (codes[`${status} ${code}`] ?? 0) + 1;
        }
      },
    });
    if (Object.keys(codes).length) json("  errores", codes);
    line(`  RSS del servicio ${service.rssMiB().toFixed(0)} MiB`);
    results.push(result);
    await sleep(2000);
  }
}

heading("GET /v1/credentials/:commitment/opening (reconstruye el árbol en cada petición)");
for (const connections of OPENING_CONCURRENCY) {
  results.push(
    await runLoad({
      url: service.url,
      title: "GET /v1/credentials/:commitment/opening",
      connections,
      durationSeconds: OPENING_DURATION,
      method: "GET",
      path: () => `/v1/credentials/${next(commitments)}/opening`,
      credentials: partners.platform!,
    }),
  );
  await sleep(2000);
}

await service.stop();
heading("Registro del servicio");
json("resumen", summarizeServiceLog(service.logPath));

heading("Contabilidad del registro de accesos");
const after = await tableCounts();
const answered = results.reduce((sum, r) => sum + r.requests, 0);
line(`respuestas ${answered} · entradas nuevas del registro ${after.accessLog - before.accessLog}`);

heading("Resumen S2");
for (const r of results) {
  line(`${r.title} c=${r.connections}: ${r.rps.toFixed(1)} rps · p50 ${ms(r.latency.p50)} · p95 ${ms(r.latency.p95)} · p99 ${ms(r.latency.p99)} · no 2xx ${Object.entries(r.statuses).filter(([s]) => !s.startsWith("2")).reduce((n, [, c]) => n + c, 0)}`);
}
process.exit(0);
