import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { groth16, type Groth16Proof } from "snarkjs";
import { encodeAbiParameters, type Hex } from "viem";

import type { CircuitInput } from "./witness.js";

export const PUBLIC_SIGNAL_NAMES = ["credentialRoot", "countryRoot", "assetId", "epochEnd", "nullifier", "anchor"] as const;

export interface ProvingArtifacts {
  wasmPath: string;
  zkeyPath: string;
  verificationKeyPath: string;
}

export function circuitArtifacts(circuitsBuildDir: string): ProvingArtifacts {
  return {
    wasmPath: resolve(circuitsBuildDir, "compliance_js/compliance.wasm"),
    zkeyPath: resolve(circuitsBuildDir, "groth16.zkey"),
    verificationKeyPath: resolve(circuitsBuildDir, "groth16.vkey.json"),
  };
}

/// The body of `POST /v1/verifications`: `exportSolidityCallData`, as the platform submits it.
export interface Groth16CallData {
  a: [Hex, Hex];
  b: [[Hex, Hex], [Hex, Hex]];
  c: [Hex, Hex];
  signals: [Hex, Hex, Hex, Hex, Hex, Hex];
}

export interface ComplianceProof {
  proof: Groth16Proof;
  publicSignals: string[];
  callData: Groth16CallData;
}

export async function proveCompliance(input: CircuitInput, artifacts: ProvingArtifacts): Promise<ComplianceProof> {
  const { proof, publicSignals } = await groth16.fullProve(input, artifacts.wasmPath, artifacts.zkeyPath);
  const raw = await groth16.exportSolidityCallData(proof, publicSignals);
  const [a, b, c, signals] = JSON.parse(`[${raw}]`) as [
    Groth16CallData["a"],
    Groth16CallData["b"],
    Groth16CallData["c"],
    Groth16CallData["signals"],
  ];
  return { proof, publicSignals, callData: { a, b, c, signals } };
}

export async function verifyLocally(proof: ComplianceProof, verificationKeyPath: string): Promise<boolean> {
  const key = JSON.parse(await readFile(verificationKeyPath, "utf8")) as unknown;
  return groth16.verify(key, proof.publicSignals, proof.proof);
}

/// The two arguments `ComplianceAttestor.attestFor(subject, proof, signals)` takes after the subject.
export function attestorArguments(callData: Groth16CallData): { proof: Hex; signals: readonly bigint[] } {
  const words = (pair: readonly Hex[]) => pair.map((value) => BigInt(value));
  const proof = encodeAbiParameters(
    [{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }],
    [
      words(callData.a) as [bigint, bigint],
      [words(callData.b[0]), words(callData.b[1])] as [[bigint, bigint], [bigint, bigint]],
      words(callData.c) as [bigint, bigint],
    ],
  );
  return { proof, signals: callData.signals.map((value) => BigInt(value)) };
}

/// snarkjs keeps a worker pool alive on the curve it caches globally; a process
/// that proves has to release it to exit.
export async function releaseProver(): Promise<void> {
  const cached = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  if (cached) await cached.terminate();
}
