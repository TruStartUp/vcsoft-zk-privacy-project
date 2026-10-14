import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as snarkjs from "snarkjs";

import { REPO_DIR } from "./lib/env.js";
import { formatSummary, heading, line, machine, ms, summarize } from "./lib/stats.js";

const RUNS = Number(process.env.RUNS ?? 30);
const PARALLEL = (process.env.PARALLEL ?? "4,8").split(",").map(Number);
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const BUILD = resolve(REPO_DIR, "zk-circuits/build");
const WASM = `${BUILD}/compliance_js/compliance.wasm`;
const SCHEMES = ["groth16", "plonk"] as const;

const { buildPoseidon } = await import("circomlibjs");
const poseidon = await buildPoseidon();
const hash = (...xs: bigint[]) => poseidon.F.toObject(poseidon(xs)) as bigint;

/// The same input as zk-circuits/scripts/benchmark.mjs: a full-depth path of empty
/// siblings, which costs the circuit exactly what a populated one does.
function inclusion(leaf: bigint, depth: number) {
  const siblings: bigint[] = [];
  let empty = 0n;
  let node = leaf;
  for (let i = 0; i < depth; i += 1) {
    siblings.push(empty);
    node = hash(node, empty);
    empty = hash(empty, empty);
  }
  return { root: node, pathElements: siblings.map(String), pathIndices: Array(depth).fill("0") as string[] };
}

const secret = 0x5eec12eb0ff1ce5eec12eb0ff1cen;
const country = 170n;
const expiry = BigInt(Math.floor(Date.UTC(2035, 0, 1) / 1000));
const assetId = 42n;
const epochLength = 2_592_000n;
const epochEnd = (BigInt(Math.floor(Date.now() / 1000)) / epochLength + 1n) * epochLength;
const credential = inclusion(hash(hash(secret), country, expiry), 20);
const jurisdiction = inclusion(country, 8);
const input = {
  credentialRoot: String(credential.root),
  countryRoot: String(jurisdiction.root),
  assetId: String(assetId),
  epochEnd: String(epochEnd),
  nullifier: String(hash(secret, assetId, epochEnd)),
  anchor: String(0x9c0f5e2d1b3a47869c0f5e2d1b3a4786n),
  secret: String(secret),
  country: String(country),
  expiry: String(expiry),
  credentialPathElements: credential.pathElements,
  credentialPathIndices: credential.pathIndices,
  countryPathElements: jurisdiction.pathElements,
  countryPathIndices: jurisdiction.pathIndices,
};

let peakRss = 0;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 100);
const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(0)} MiB`;

machine();
line(`RUNS=${RUNS} · paralelo ${PARALLEL.join("/")} con ${ROUNDS} rondas · un proceso, el reparto en hilos es el de snarkjs`);

for (const scheme of SCHEMES) {
  const zkey = `${BUILD}/${scheme}.zkey`;
  const vkey = JSON.parse(readFileSync(`${BUILD}/${scheme}.vkey.json`, "utf8"));
  const prover = snarkjs[scheme] as unknown as {
    fullProve(i: unknown, w: string, z: string): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(v: unknown, s: string[], p: unknown): Promise<boolean>;
  };

  heading(`${scheme}: ${RUNS} pruebas en serie`);
  peakRss = process.memoryUsage().rss;
  const prove: number[] = [];
  const verify: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    let t = performance.now();
    const { proof, publicSignals } = await prover.fullProve(input, WASM, zkey);
    prove.push(performance.now() - t);
    t = performance.now();
    if (!(await prover.verify(vkey, publicSignals, proof))) throw new Error(`${scheme}: the proof did not verify`);
    verify.push(performance.now() - t);
  }
  line(`generar: ${formatSummary(summarize(prove))}`);
  line(`verificar en JS: ${formatSummary(summarize(verify))}`);
  line(`RSS máximo ${mib(peakRss)}`);

  for (const width of PARALLEL) {
    heading(`${scheme}: ${width} pruebas a la vez, ${ROUNDS} rondas`);
    peakRss = process.memoryUsage().rss;
    const latencies: number[] = [];
    const walls: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const start = performance.now();
      await Promise.all(
        Array.from({ length: width }, async () => {
          const t = performance.now();
          await prover.fullProve(input, WASM, zkey);
          latencies.push(performance.now() - t);
        }),
      );
      walls.push(performance.now() - start);
    }
    const wall = summarize(walls);
    line(`latencia de cada prueba: ${formatSummary(summarize(latencies))}`);
    line(`ronda completa: mediana ${ms(wall.p50)} · ${((width * 1000) / wall.p50).toFixed(2)} pruebas/s frente a ${(1000 / summarize(prove).p50).toFixed(2)} en serie`);
    line(`RSS máximo ${mib(peakRss)}`);
  }
}

clearInterval(sampler);
const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
if (curve) await curve.terminate();
process.exit(0);
