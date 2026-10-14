import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const B = resolve(import.meta.dirname, "../build");
const poseidon = await buildPoseidon();
const hash = (...xs) => poseidon.F.toObject(poseidon(xs));

function inclusion(leaf, depth) {
  const siblings = [];
  let empty = 0n, node = leaf;
  for (let i = 0; i < depth; i++) { siblings.push(empty); node = hash(node, empty); empty = hash(empty, empty); }
  return { root: node, pathElements: siblings.map(String), pathIndices: Array(depth).fill("0") };
}

const secret = 0x5eec12eb0ff1ce5eec12eb0ff1cen;
const country = 170n;
const expiry = BigInt(Math.floor(Date.UTC(2035, 0, 1) / 1000));
const assetId = 42n;
const epochLength = 2592000n;
const epochEnd = (BigInt(Math.floor(Date.now() / 1000)) / epochLength + 1n) * epochLength;
const anchor = 0x9c0f5e2d1b3a47869c0f5e2d1b3a4786n;
const credential = inclusion(hash(hash(secret), country, expiry), 20);
const jurisdiction = inclusion(country, 8);

const input = {
  credentialRoot: String(credential.root), countryRoot: String(jurisdiction.root),
  assetId: String(assetId), epochEnd: String(epochEnd),
  nullifier: String(hash(secret, assetId, epochEnd)), anchor: String(anchor),
  secret: String(secret), country: String(country), expiry: String(expiry),
  credentialPathElements: credential.pathElements, credentialPathIndices: credential.pathIndices,
  countryPathElements: jurisdiction.pathElements, countryPathIndices: jurisdiction.pathIndices,
};

const out = {};
for (const scheme of ["groth16", "plonk"]) {
  const { proof, publicSignals } = await snarkjs[scheme].fullProve(
    input, `${B}/compliance_js/compliance.wasm`, `${B}/${scheme}.zkey`);
  // plonk returns its two arrays without a separator between them; groth16 already has one.
  const raw = await snarkjs[scheme].exportSolidityCallData(proof, publicSignals);
  out[scheme] = JSON.parse(`[${raw.replace(/\]\s*\[/g, "],[")}]`);
}
await writeFile(`${B}/calldata.json`, JSON.stringify(out, null, 1));
console.log("· calldata de ambos esquemas guardada");
process.exit(0);
