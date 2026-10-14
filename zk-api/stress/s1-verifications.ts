import "./lib/load-env.js";

import { StressClient, type PartnerCredentials } from "./lib/client.js";
import { LOCAL_RPC_URL, readJson, readLocalDeployment, requireStressStores } from "./lib/env.js";
import { chainClient, groth16CallData, plonkCallData, releaseProver, witnessFor } from "./lib/holder.js";
import { restoreHolder, type StoredHolder } from "./lib/holders.js";
import { runLoad, type LoadResult } from "./lib/load.js";
import { tableCounts } from "./lib/db.js";
import { startService, summarizeServiceLog, type RunningService } from "./lib/service.js";
import { heading, json, line, machine, ms, sleep } from "./lib/stats.js";

const ASSET_ID = 42n;
const DURATION = Number(process.env.STRESS_DURATION ?? 60);
const GROTH16_CONCURRENCY = [1, 8, 32];
const PLONK_CONCURRENCY = [8];

requireStressStores(process.env.DATABASE_URL!, process.env.REDIS_URL!);
machine();
const deployment = readLocalDeployment();
const partners = readJson<Record<string, PartnerCredentials>>("partners.json");
const holder = restoreHolder(readJson<StoredHolder[]>("holders.json")[0]!);

heading("Prueba real del titular (hoja 0), Groth16 y PLONK sobre el mismo testigo");
let service = await startService("s1-groth16");
const platform = new StressClient(service.url, partners.platform!);
const witness = await witnessFor(platform, holder, chainClient(LOCAL_RPC_URL), deployment.complianceAttestor, ASSET_ID);
let t0 = performance.now();
const groth16 = await groth16CallData(witness);
line(`prueba Groth16 generada en ${ms(performance.now() - t0)}`);
t0 = performance.now();
const plonk = await plonkCallData(witness);
line(`prueba PLONK generada en ${ms(performance.now() - t0)}`);
await releaseProver();

function sampler(target: RunningService) {
  const samples: number[] = [];
  const timer = setInterval(() => samples.push(target.rssMiB()), 1000);
  return {
    stop() {
      clearInterval(timer);
      return samples.length ? Math.max(...samples) : Number.NaN;
    },
  };
}

async function pass(target: RunningService, scheme: string, proof: unknown, concurrency: number[]): Promise<LoadResult[]> {
  const bank = new StressClient(target.url, partners.bank!);
  const probe = await bank.post("/v1/verifications", { proof });
  json(`comprobación previa (${scheme})`, { status: probe.status, valid: probe.body?.valid, rejectionCode: probe.body?.rejectionCode, ms: probe.ms });
  if (probe.status !== 201 || probe.body?.valid !== true) throw new Error(`the ${scheme} proof did not verify before the run`);

  const results: LoadResult[] = [];
  for (const connections of concurrency) {
    const verdicts: Record<string, number> = {};
    const memory = sampler(target);
    const result = await runLoad({
      url: target.url,
      title: `POST /v1/verifications (${scheme})`,
      connections,
      durationSeconds: DURATION,
      method: "POST",
      path: () => "/v1/verifications",
      body: () => ({ proof }),
      credentials: partners.bank!,
      inspect: (status, body) => {
        let key = String(status);
        try {
          const parsed = JSON.parse(body) as { valid?: boolean; code?: string; rejectionCode?: string | null };
          key = status === 201 ? `valid=${parsed.valid}${parsed.rejectionCode ? ` ${parsed.rejectionCode}` : ""}` : `${status} ${parsed.code}`;
        } catch {
          key = `${status} (cuerpo no JSON)`;
        }
        verdicts[key] = (verdicts[key] ?? 0) + 1;
      },
    });
    json("  veredictos", verdicts);
    line(`  RSS máximo del servicio ${memory.stop().toFixed(0)} MiB`);
    results.push(result);
    await sleep(2000);
  }
  return results;
}

const before = await tableCounts();
json("filas antes", before);
const results = await pass(service, "groth16", groth16, GROTH16_CONCURRENCY);
await service.stop();
json("registro del servicio (groth16)", summarizeServiceLog(service.logPath));

heading("Pasada PLONK: mismo servicio con PROOF_SCHEME=plonk y su clave");
service = await startService("s1-plonk", {
  PROOF_SCHEME: "plonk",
  PROOF_VERIFICATION_KEY_PATH: "../zk-circuits/build/plonk.vkey.json",
});
results.push(...(await pass(service, "plonk", plonk, PLONK_CONCURRENCY)));
await service.stop();
json("registro del servicio (plonk)", summarizeServiceLog(service.logPath));

heading("Contabilidad: respuestas frente a filas escritas");
const after = await tableCounts();
json("filas después", after);
const answered = results.reduce((sum, r) => sum + r.requests, 0) + 2;
const created = results.reduce((sum, r) => sum + (r.statuses["201"] ?? 0), 0) + 2;
line(`respuestas ${answered} · 201 ${created} · verificaciones nuevas en BD ${after.proofVerifications - before.proofVerifications}`);
line(`entradas nuevas del registro de accesos ${after.accessLog - before.accessLog} (se esperan ${answered})`);

heading("Resumen S1");
for (const r of results) {
  line(`${r.title} c=${r.connections}: ${r.rps.toFixed(1)} rps · p50 ${ms(r.latency.p50)} · p95 ${ms(r.latency.p95)} · p99 ${ms(r.latency.p99)} · 5xx ${Object.entries(r.statuses).filter(([s]) => s.startsWith("5")).reduce((n, [, c]) => n + c, 0)}`);
}
process.exit(0);
