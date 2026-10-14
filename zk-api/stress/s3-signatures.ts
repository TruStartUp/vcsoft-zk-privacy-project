import "./lib/load-env.js";

import { randomBytes } from "node:crypto";

import { signedHeaders, type PartnerCredentials, type SignatureOverrides } from "./lib/client.js";
import { tableCounts } from "./lib/db.js";
import { readJson, requireStressStores } from "./lib/env.js";
import { startService, summarizeServiceLog } from "./lib/service.js";
import { formatSummary, heading, json, line, machine, summarize } from "./lib/stats.js";

const VALID = Number(process.env.STRESS_VALID ?? 10_000);
const PER_INVALID_KIND = Number(process.env.STRESS_INVALID_PER_KIND ?? 250);
const CONCURRENCY = 16;
const RACERS = 200;
const RACES = 20;
const PATH = "/v1/access-log?limit=1";

requireStressStores(process.env.DATABASE_URL!, process.env.REDIS_URL!);
machine();
const partners = readJson<Record<string, PartnerCredentials>>("partners.json");
const audit = partners.audit!;
const service = await startService("s3");
const before = await tableCounts();

interface Shot {
  kind: string;
  expectStatus: number;
  expectCode: string | null;
  headers: () => Record<string, string>;
  path?: string;
}

async function fire(shot: Shot) {
  const started = performance.now();
  const response = await fetch(`${service.url}${shot.path ?? PATH}`, { headers: shot.headers() });
  const text = await response.text();
  const elapsed = performance.now() - started;
  let code: string | null = null;
  try {
    code = (JSON.parse(text) as { code?: string }).code ?? null;
  } catch {
    code = null;
  }
  return { status: response.status, code, ms: elapsed };
}

async function pool<T, R>(items: T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (index < items.length) {
        const mine = index++;
        results[mine] = await work(items[mine]!);
      }
    }),
  );
  return results;
}

const now = () => Math.floor(Date.now() / 1000);
const sign = (overrides: SignatureOverrides = {}, credentials = audit, path = PATH) =>
  signedHeaders(credentials, "GET", path, Buffer.alloc(0), overrides);

heading(`${VALID} peticiones firmadas válidas (c=${CONCURRENCY})`);
const validShots: Shot[] = Array.from({ length: VALID }, () => ({
  kind: "válida",
  expectStatus: 200,
  expectCode: null,
  headers: () => sign(),
}));
let t0 = performance.now();
const validResults = await pool(validShots, CONCURRENCY, fire);
let wall = (performance.now() - t0) / 1000;
const validOk = validResults.filter((r) => r.status === 200).length;
line(`${validOk}/${VALID} aceptadas en ${wall.toFixed(1)} s · ${(VALID / wall).toFixed(0)} rps · ${formatSummary(summarize(validResults.map((r) => r.ms)))}`);
const validStatuses: Record<string, number> = {};
for (const r of validResults) validStatuses[`${r.status} ${r.code ?? ""}`.trim()] = (validStatuses[`${r.status} ${r.code ?? ""}`.trim()] ?? 0) + 1;
json("estados", validStatuses);

heading(`Mezcla de peticiones inválidas (${PER_INVALID_KIND} de cada tipo)`);
const kinds: Shot[] = [
  { kind: "firma inventada", expectStatus: 401, expectCode: "invalid_signature", headers: () => sign({ signature: randomBytes(32).toString("hex") }) },
  {
    kind: "consulta cambiada tras firmar",
    expectStatus: 401,
    expectCode: "invalid_signature",
    headers: () => sign({}, audit, "/v1/access-log?limit=1"),
    path: "/v1/access-log?limit=2",
  },
  {
    kind: "firmada con otro secreto",
    expectStatus: 401,
    expectCode: "invalid_signature",
    headers: () => sign({}, { partnerKey: audit.partnerKey, secret: randomBytes(32).toString("base64url") }),
  },
  { kind: "marca de tiempo vencida (−310 s)", expectStatus: 401, expectCode: "signature_window_expired", headers: () => sign({ timestamp: now() - 310 }) },
  { kind: "marca de tiempo futura (+310 s)", expectStatus: 401, expectCode: "signature_window_expired", headers: () => sign({ timestamp: now() + 310 }) },
  {
    kind: "marca de tiempo no numérica",
    expectStatus: 401,
    expectCode: "malformed_timestamp",
    headers: () => ({ ...sign(), "x-partner-timestamp": "yesterday" }),
  },
  { kind: "nonce demasiado corto", expectStatus: 401, expectCode: "malformed_nonce", headers: () => sign({ nonce: "abc" }) },
  { kind: "socio desconocido", expectStatus: 401, expectCode: "unknown_partner", headers: () => sign({ partnerKey: `pk_${randomBytes(12).toString("hex")}` }) },
  {
    kind: "sin cabeceras de firma",
    expectStatus: 401,
    expectCode: "missing_partner_credentials",
    headers: () => {
      const { "x-partner-signature": _drop, ...rest } = sign();
      return rest;
    },
  },
  { kind: "alcance que el socio no tiene", expectStatus: 403, expectCode: "insufficient_scope", headers: () => sign({}, partners.bank!) },
];
const invalidShots = kinds.flatMap((kind) => Array.from({ length: PER_INVALID_KIND }, () => kind));
for (let i = invalidShots.length - 1; i > 0; i -= 1) {
  const j = Math.floor(Math.random() * (i + 1));
  [invalidShots[i], invalidShots[j]] = [invalidShots[j]!, invalidShots[i]!];
}
t0 = performance.now();
const invalidResults = await pool(invalidShots, CONCURRENCY, async (shot) => ({ shot, result: await fire(shot) }));
wall = (performance.now() - t0) / 1000;
const byKind = new Map<string, { total: number; correct: number; seen: Record<string, number> }>();
for (const { shot, result } of invalidResults) {
  const entry = byKind.get(shot.kind) ?? { total: 0, correct: 0, seen: {} };
  entry.total += 1;
  if (result.status === shot.expectStatus && result.code === shot.expectCode) entry.correct += 1;
  const seen = `${result.status} ${result.code}`;
  entry.seen[seen] = (entry.seen[seen] ?? 0) + 1;
  byKind.set(shot.kind, entry);
}
let correct = 0;
for (const [kind, entry] of byKind) {
  correct += entry.correct;
  line(`  ${kind}: ${entry.correct}/${entry.total} con el código esperado · ${JSON.stringify(entry.seen)}`);
}
line(`${correct}/${invalidShots.length} rechazos correctos (${((100 * correct) / invalidShots.length).toFixed(2)} %) en ${wall.toFixed(1)} s`);

heading(`Repetición inmediata: ${PER_INVALID_KIND} peticiones válidas reenviadas tal cual`);
let replayRejected = 0;
let replayFirstAccepted = 0;
await pool(Array.from({ length: PER_INVALID_KIND }), CONCURRENCY, async () => {
  const headers = sign();
  const first = await fire({ kind: "original", expectStatus: 200, expectCode: null, headers: () => headers });
  const second = await fire({ kind: "repetida", expectStatus: 401, expectCode: "replayed_nonce", headers: () => headers });
  if (first.status === 200) replayFirstAccepted += 1;
  if (second.status === 401 && second.code === "replayed_nonce") replayRejected += 1;
});
line(`originales aceptadas ${replayFirstAccepted}/${PER_INVALID_KIND} · repeticiones rechazadas con replayed_nonce ${replayRejected}/${PER_INVALID_KIND}`);

heading(`Carrera por el nonce: ${RACERS} clientes concurrentes con el mismo nonce, ${RACES} rondas`);
const raceOutcomes: number[] = [];
for (let round = 0; round < RACES; round += 1) {
  const nonce = randomBytes(12).toString("hex");
  const timestamp = now();
  const differentPaths = round % 2 === 1;
  const shots = Array.from({ length: RACERS }, (_, i) => {
    const path = differentPaths ? `/v1/access-log?limit=${(i % 50) + 1}` : PATH;
    const headers = sign({ nonce, timestamp }, audit, path);
    return fire({ kind: "carrera", expectStatus: 0, expectCode: null, headers: () => headers, path });
  });
  const results = await Promise.all(shots);
  const accepted = results.filter((r) => r.status === 200).length;
  const replayed = results.filter((r) => r.status === 401 && r.code === "replayed_nonce").length;
  const other = RACERS - accepted - replayed;
  raceOutcomes.push(accepted);
  line(`  ronda ${round + 1} (${differentPaths ? "50 rutas distintas" : "petición idéntica"}): aceptadas ${accepted} · replayed_nonce ${replayed} · otras ${other}`);
}
line(`rondas con exactamente una aceptada: ${raceOutcomes.filter((n) => n === 1).length}/${RACES}`);

await service.stop();
heading("Registro del servicio");
json("resumen", summarizeServiceLog(service.logPath));
const after = await tableCounts();
const sent = VALID + invalidShots.length + 2 * PER_INVALID_KIND + RACERS * RACES;
line(`peticiones enviadas ${sent} · entradas nuevas del registro de accesos ${after.accessLog - before.accessLog}`);
process.exit(0);
