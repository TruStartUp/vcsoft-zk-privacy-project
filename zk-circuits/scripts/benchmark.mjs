import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const B = resolve(import.meta.dirname, "../build");
const CREDENTIAL_DEPTH = 20;
const COUNTRY_DEPTH = 8;
const RUNS = 5;

const poseidon = await buildPoseidon();
const F = poseidon.F;
const hash = (...xs) => F.toObject(poseidon(xs));

/** A path of empty siblings: enough to exercise the circuit at full depth. */
function inclusion(leaf, depth) {
  const siblings = [];
  let empty = 0n;
  let node = leaf;
  for (let i = 0; i < depth; i++) {
    siblings.push(empty);
    node = hash(node, empty);
    empty = hash(empty, empty);
  }
  return { root: node, pathElements: siblings.map(String), pathIndices: Array(depth).fill("0") };
}

const secret = 0x5eec12eb0ff1ce5eec12eb0ff1cen;
const country = 170n;                      // ISO 3166-1 numérico · Colombia
const expiry = BigInt(Math.floor(Date.UTC(2035, 0, 1) / 1000));
const assetId = 42n;
const epochLength = 2592000n;
const epochEnd = (BigInt(Math.floor(Date.now() / 1000)) / epochLength + 1n) * epochLength;
const anchor = 0x9c0f5e2d1b3a47869c0f5e2d1b3a4786n;

const credential = inclusion(hash(hash(secret), country, expiry), CREDENTIAL_DEPTH);
const jurisdiction = inclusion(country, COUNTRY_DEPTH);

const input = {
  credentialRoot: String(credential.root),
  countryRoot: String(jurisdiction.root),
  assetId: String(assetId),
  epochEnd: String(epochEnd),
  nullifier: String(hash(secret, assetId, epochEnd)),
  anchor: String(anchor),
  secret: String(secret),
  country: String(country),
  expiry: String(expiry),
  credentialPathElements: credential.pathElements,
  credentialPathIndices: credential.pathIndices,
  countryPathElements: jurisdiction.pathElements,
  countryPathIndices: jurisdiction.pathIndices,
};

const wasm = `${B}/compliance_js/compliance.wasm`;
const results = [];

for (const scheme of ["groth16", "plonk"]) {
  const zkey = `${B}/${scheme}.zkey`;
  const vkey = JSON.parse(await readFile(`${B}/${scheme}.vkey.json`, "utf8"));

  let proof, publicSignals, prove = [], verify = [];
  for (let i = 0; i < RUNS; i++) {
    let t = performance.now();
    ({ proof, publicSignals } = await snarkjs[scheme].fullProve(input, wasm, zkey));
    prove.push(performance.now() - t);

    t = performance.now();
    const ok = await snarkjs[scheme].verify(vkey, publicSignals, proof);
    verify.push(performance.now() - t);
    if (!ok) throw new Error(`${scheme}: the proof did not verify`);
  }

  const calldata = await snarkjs[scheme].exportSolidityCallData(proof, publicSignals);
  const bytes = (calldata.match(/0x[0-9a-fA-F]+/g) ?? []).reduce((n, h) => n + (h.length - 2) / 2, 0);
  const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];

  results.push({
    esquema: scheme,
    "clave de prueba": `${((await stat(zkey)).size / 1e6).toFixed(1)} MB`,
    "generar (mediana)": `${median(prove).toFixed(0)} ms`,
    "verificar en JS": `${median(verify).toFixed(1)} ms`,
    "prueba (calldata)": `${bytes} B`,
  });
}

console.table(results);
process.exit(0);
