import "./lib/load-env.js";

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import * as snarkjs from "snarkjs";

import { StressClient, type PartnerCredentials } from "./lib/client.js";
import { stressPrisma } from "./lib/db.js";
import { readJson, readLocalDeployment, requireStressStores } from "./lib/env.js";
import { ARTIFACTS, activate, newHolder, register, releaseProver, type Prover } from "./lib/holder.js";
import { startService, summarizeServiceLog } from "./lib/service.js";
import { heading, json, line, machine, ms, rss } from "./lib/stats.js";

const { SparseMerkleTree } = await import("../src/lib/merkle.js");
const { poseidonHash } = await import("../src/lib/poseidon.js");
const { CREDENTIAL_TREE_DEPTH, JURISDICTION_TREE_DEPTH } = await import("../src/lib/field.js");
type HashFn = (...inputs: bigint[]) => bigint;

const CAPACITY = 2 ** CREDENTIAL_TREE_DEPTH;
const FROM_SIZES = [1_000, 10_000, 100_000];
const LEVELED_SIZES = [1_000, 10_000, 100_000, CAPACITY];

requireStressStores(process.env.DATABASE_URL!, process.env.REDIS_URL!);
machine();
const hash = await poseidonHash();
const leafValue = (index: number) => hash(BigInt(index) + 1n, 170n, 2_000_000_000n);

/// Builds the same tree level by level: every node is hashed once, instead of once
/// per leaf below it. Used here only to measure what that would save; the service
/// builds with SparseMerkleTree.from.
function leveledTree(hashFn: HashFn, depth: number, leaves: Map<number, bigint>) {
  const zeros = [0n];
  for (let level = 0; level < depth; level += 1) zeros.push(hashFn(zeros[level]!, zeros[level]!));
  const levels: Map<number, bigint>[] = [leaves];
  for (let level = 0; level < depth; level += 1) {
    const current = levels[level]!;
    const parents = new Map<number, bigint>();
    for (const index of current.keys()) {
      const parent = index >> 1;
      if (parents.has(parent)) continue;
      parents.set(parent, hashFn(current.get(parent * 2) ?? zeros[level]!, current.get(parent * 2 + 1) ?? zeros[level]!));
    }
    levels.push(parents);
  }
  return {
    root: levels[depth]!.get(0) ?? zeros[depth]!,
    opening(index: number) {
      const pathElements: string[] = [];
      const pathIndices: string[] = [];
      let cursor = index;
      for (let level = 0; level < depth; level += 1) {
        pathElements.push(String(levels[level]!.get(cursor ^ 1) ?? zeros[level]!));
        pathIndices.push(String(cursor & 1));
        cursor >>= 1;
      }
      return { pathElements, pathIndices };
    },
  };
}

function countingHash(): { fn: HashFn; calls: () => number } {
  let calls = 0;
  return {
    fn: (...inputs: bigint[]) => {
      calls += 1;
      return hash(...inputs);
    },
    calls: () => calls,
  };
}

heading("Coste de construir el árbol de credenciales (profundidad 20) en memoria");
const fromRoots = new Map<number, bigint>();
for (const size of FROM_SIZES) {
  const counter = countingHash();
  const t0 = performance.now();
  const tree = SparseMerkleTree.from(
    CREDENTIAL_TREE_DEPTH,
    counter.fn,
    (function* () {
      for (let i = 0; i < size; i += 1) yield [i, leafValue(i)] as [number, bigint];
    })(),
  );
  const elapsed = performance.now() - t0;
  fromRoots.set(size, tree.root());
  line(`SparseMerkleTree.from con ${size} hojas: ${ms(elapsed)} · ${counter.calls()} llamadas a Poseidon · ${((1000 * elapsed) / counter.calls()).toFixed(1)} µs por llamada · RSS del proceso ${rss()}`);
}

const secret = 0x5eec12eb0ff1ce5eec12eb0ff1cen;
const expiry = 2_000_000_000n;
const country = 170n;
const commitment = hash(hash(secret), country, expiry);

let full: ReturnType<typeof leveledTree> | undefined;
for (const size of LEVELED_SIZES) {
  const leaves = new Map<number, bigint>();
  const tLeaves = performance.now();
  for (let i = 0; i < size; i += 1) leaves.set(i, leafValue(i));
  if (size === CAPACITY) leaves.set(CAPACITY - 1, commitment);
  const leafMs = performance.now() - tLeaves;
  const counter = countingHash();
  const t0 = performance.now();
  const tree = leveledTree(counter.fn, CREDENTIAL_TREE_DEPTH, leaves);
  const elapsed = performance.now() - t0;
  const same = fromRoots.has(size) ? ` · raíz idéntica a SparseMerkleTree.from=${fromRoots.get(size) === tree.root}` : "";
  const note = size === CAPACITY ? " · la última hoja es el compromiso de un titular de prueba" : "";
  line(`por niveles con ${size} hojas: ${ms(elapsed)} (+${ms(leafMs)} para calcular las hojas) · ${counter.calls()} llamadas a Poseidon${same}${note} · RSS ${rss()}`);
  if (size === CAPACITY) full = tree;
}

heading(`Prueba Groth16 con la hoja en el índice 2^20 − 1 = ${CAPACITY - 1} de un árbol lleno`);
const lastFull = full!;
const opening = lastFull.opening(CAPACITY - 1);
const checker = new SparseMerkleTree(CREDENTIAL_TREE_DEPTH, hash);
line(`la apertura recompone la raíz con la verificación del servicio: ${checker.verifyOpening(commitment, opening) === lastFull.root} · índices de camino todos 1: ${opening.pathIndices.every((b) => b === "1")}`);
const countryTree = SparseMerkleTree.from(JURISDICTION_TREE_DEPTH, hash, [[255, country]]);
const assetId = 42n;
const epochEnd = (BigInt(Math.floor(Date.now() / 1000)) / 2_592_000n + 1n) * 2_592_000n;
const input = {
  credentialRoot: String(lastFull.root),
  countryRoot: String(countryTree.root()),
  assetId: String(assetId),
  epochEnd: String(epochEnd),
  nullifier: String(hash(secret, assetId, epochEnd)),
  anchor: "123456789",
  secret: String(secret),
  country: String(country),
  expiry: String(expiry),
  credentialPathElements: opening.pathElements,
  credentialPathIndices: opening.pathIndices,
  countryPathElements: countryTree.opening(255).pathElements,
  countryPathIndices: countryTree.opening(255).pathIndices,
};
const t2 = performance.now();
const groth16 = (snarkjs as unknown as { groth16: Prover }).groth16;
const { proof, publicSignals } = await groth16.fullProve(input, ARTIFACTS.wasmPath, ARTIFACTS.zkeyPath);
const vkey = JSON.parse(readFileSync(ARTIFACTS.verificationKeyPath, "utf8"));
line(`prueba en ${ms(performance.now() - t2)} · verifica: ${await snarkjs.groth16.verify(vkey, publicSignals, proof as never)} · hoja de jurisdicción en la última posición (255) también`);
await releaseProver();

heading("Agotamiento: activación con el árbol lleno (servicio real)");
const deployment = readLocalDeployment();
const partners = readJson<Record<string, PartnerCredentials>>("partners.json");
const domain = { chainId: deployment.chainId, credentialRegistry: deployment.credentialRegistry };
const service = await startService("s8");
const platform = new StressClient(service.url, partners.platform!);
const operator = new StressClient(service.url, partners.operator!);
const prisma = await stressPrisma();

const sentinelId = randomUUID();
await prisma.credential.create({
  data: {
    id: sentinelId,
    subjectRef: `stress-capacity-${sentinelId}`,
    holderAddress: "0x0000000000000000000000000000000000000001",
    commitment: String(hash(BigInt(CAPACITY), 1n, 1n)),
    secretHash: String(hash(BigInt(CAPACITY))),
    leafIndex: CAPACITY - 1,
    countryCode: 170,
    expiresAt: new Date(Date.now() + 86_400_000),
    status: "REVOKED",
    inTree: false,
    verificationRef: "stress-capacity-sentinel",
  },
});
line(`fila centinela fuera del árbol ocupando la posición ${CAPACITY - 1} (inTree=false: no cambia la raíz)`);
const holder = await newHolder(170);
await register(platform, holder);
const full409 = await activate(platform, holder, domain);
json("activación con el árbol lleno", { status: full409.status, code: full409.body?.code, details: full409.body?.details });
const row = await prisma.credential.findUnique({ where: { id: holder.credentialId! } });
json("la credencial queda", { status: row?.status, inTree: row?.inTree, leafIndex: row?.leafIndex, commitment: row?.commitment });
const cancelled = await platform.post(`/v1/credentials/${holder.credentialId}/cancellation`);
line(`cancelación de la pendiente: ${cancelled.status}`);
await prisma.credential.delete({ where: { id: sentinelId } });
line("fila centinela retirada");

heading("Árbol de jurisdicciones: 256 países y uno más");
const asset = String(900_000 + Math.floor(Math.random() * 1000));
const codes = Array.from({ length: 256 }, (_, i) => i + 1);
const at256 = await platform.put(`/v1/assets/${asset}/jurisdictions`, { admitted: codes });
json(`256 países en el activo ${asset}`, { status: at256.status, leafCount: at256.body?.leafCount, ms: at256.ms });
const at257 = await platform.put(`/v1/assets/${asset}/jurisdictions`, { admitted: [...codes, 257] });
json("257 países", { status: at257.status, code: at257.body?.code, issues: at257.body?.details?.issues });
const rebuilt = await operator.post(`/v1/issuer/assets/${asset}/state/rebuild`);
json("reconstrucción del activo", { status: rebuilt.status, matchesChain: rebuilt.body?.matchesChain, leafCount: rebuilt.body?.leafCount });
const reconciled = await operator.post("/v1/issuer/state/rebuild");
json("reconciliación de credenciales", {
  matchesChain: reconciled.body?.matchesChain,
  missingFromDatabase: reconciled.body?.missingFromDatabase?.length,
  missingFromChain: reconciled.body?.missingFromChain?.length,
});

await service.stop();
heading("Registro del servicio");
json("resumen", summarizeServiceLog(service.logPath));
process.exit(0);
