import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

const ROOT = resolve(import.meta.dirname, "..");
const WASM = join(ROOT, "build/compliance_js/compliance.wasm");
const R1CS = join(ROOT, "build/compliance.r1cs");
const SYMBOLS = join(ROOT, "build/compliance.sym");
const SOURCE = join(ROOT, "circuits/compliance.circom");

export const FIELD_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const CREDENTIAL_DEPTH = 20;
export const COUNTRY_DEPTH = 8;
export const TIMESTAMP_BITS = 64;
export const COUNTRY_CODE_BITS = 16;

const poseidon = await buildPoseidon();
export const hash = (...inputs) => poseidon.F.toObject(poseidon(inputs));

/// Same shape the issuer builds off-chain: unfilled positions hold the digest of
/// the all-zero subtree of that height.
export function merkleTree(leaves, depth) {
  const zero = [0n];
  for (let level = 0; level < depth; level++) zero.push(hash(zero[level], zero[level]));

  const levels = [[...leaves]];
  for (let level = 0; level < depth; level++) {
    const below = levels[level];
    const above = [];
    for (let i = 0; i < below.length; i += 2) {
      above.push(hash(below[i], below[i + 1] ?? zero[level]));
    }
    levels.push(above);
  }

  const node = (level, index) => levels[level][index] ?? zero[level];

  return {
    root: node(depth, 0),
    proof(index) {
      const pathElements = [];
      const pathIndices = [];
      for (let level = 0, i = index; level < depth; level++, i >>= 1) {
        pathElements.push(node(level, i ^ 1));
        pathIndices.push(BigInt(i & 1));
      }
      return { pathElements, pathIndices };
    },
  };
}

const decimal = (value) => (Array.isArray(value) ? value.map(decimal) : String(value));
const decimalInput = (input) =>
  Object.fromEntries(Object.entries(input).map(([name, value]) => [name, decimal(value)]));

export async function witnessOf(input) {
  const file = { type: "mem" };
  await snarkjs.wtns.calculate(decimalInput(input), WASM, file);
  return file;
}

export async function accepted(input) {
  const file = await witnessOf(input);
  await snarkjs.wtns.check(R1CS, file);
  return file.data;
}

const sourceLines = readFileSync(SOURCE, "utf8").split("\n");

function lineOf(fragment) {
  const index = sourceLines.findIndex((line) => line.includes(fragment));
  assert.ok(index >= 0, `no line of compliance.circom contains "${fragment}"`);
  return index + 1;
}

/// Witness generation aborts on the first unsatisfied `===`, and the message
/// names the line in Compliance that reached it, so a rejection can be pinned to
/// the check that was meant to catch it instead of to any check at all.
export async function rejectedAt(input, fragment) {
  const line = lineOf(fragment);
  const chatter = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  let message;
  try {
    await witnessOf(input);
  } catch (error) {
    message = error.message;
  } finally {
    Object.assign(console, chatter);
  }
  assert.ok(message !== undefined, `the circuit accepted an input it must reject (${fragment})`);
  assert.match(
    message,
    new RegExp(`Compliance\\w* line: ${line}\\b`),
    `expected the rejection to come from line ${line}, "${fragment}", but got:\n${message}`,
  );
  return message;
}

/// A signal circom folded away carries witness index -1 in the symbol table, and
/// one that survives still has to appear in a constraint to bind anything: a
/// public input absent from the R1CS gets an identity point in the verifying key
/// and the verifier ignores whatever value is handed to it.
export function witnessIndexOf(signal) {
  const line = readFileSync(SYMBOLS, "utf8")
    .split("\n")
    .find((entry) => entry.endsWith(`,${signal}`));
  assert.ok(line !== undefined, `${signal} is not in the symbol table`);
  return Number(line.split(",")[1]);
}

export async function constraintsTouching(witnessIndex) {
  const { constraints } = await snarkjs.r1cs.exportJson(R1CS);
  const key = String(witnessIndex);
  return constraints
    .map(([a, b, c], position) => ({ position, in: ["A", "B", "C"].filter((_, i) => key in [a, b, c][i]) }))
    .filter((hit) => hit.in.length > 0);
}

/// wtns.check spawns the curve's worker pool and never shuts it down, which
/// would keep the test process alive after the last assertion.
export async function releaseCurveWorkers() {
  const curve = await snarkjs.curves.getCurveFromR(FIELD_ORDER);
  await curve.terminate();
}
