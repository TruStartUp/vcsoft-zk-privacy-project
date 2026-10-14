import { groth16, plonk, type Groth16Proof, type PlonkProof } from "snarkjs";

import { PROOF_SCHEMES, type ProofScheme } from "./proof-scheme.js";

/// Everything this service knows about how a proof is written down.
///
/// Above this module a proof is a payload with six public signals and a verdict; the
/// shape of the payload, the field order inside it and the library call that checks it
/// live here and nowhere else. Replacing the proving scheme is adding a codec and
/// pointing the configuration at it -- not touching the verification service, the
/// routes, the access log or the compliance answers built on top.

export { PROOF_SCHEMES, type ProofScheme };

export const PUBLIC_SIGNAL_COUNT = 6;

/// The circuit's six public signals, in the order it declares them.
export type PublicSignalTuple = [string, string, string, string, string, string];

/// The Groth16 calldata as `snarkjs exportSolidityCallData` prints it, which is the
/// artefact a bank already holds a copy of because it is what the platform submits.
export interface Groth16CallData {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
  signals: PublicSignalTuple;
}

/// The PLONK calldata in the same sense: twenty-four words, in the order the generated
/// verifier reads them off its own calldata.
export interface PlonkCallData {
  proof: string[];
  signals: PublicSignalTuple;
}

export type ProofCallData = Groth16CallData | PlonkCallData;

export interface ProofCodec {
  readonly scheme: ProofScheme;
  /// How many 32-byte words the proof body occupies on chain.
  readonly proofWords: number;
  accepts(callData: ProofCallData): boolean;
  toSnarkjsProof(callData: ProofCallData): Groth16Proof | PlonkProof;
  verify(verificationKey: unknown, callData: ProofCallData): Promise<boolean>;
}

const decimal = (value: string): string => BigInt(value).toString(10);

/// `exportSolidityCallData` swaps the two coordinates of each Fp2 element of `B`,
/// because that is the order the pairing precompile expects. Feeding the calldata
/// straight back to snarkjs verifies a different point and always answers false, so the
/// swap has to be undone on the way in. It is a Groth16 detail through and through --
/// PLONK commits to nothing over Fp2 -- and it is the reason this translation belongs
/// behind a boundary instead of inline in a service.
export function groth16CallDataToProof(callData: Groth16CallData): Groth16Proof {
  return {
    pi_a: [decimal(callData.a[0]), decimal(callData.a[1]), "1"],
    pi_b: [
      [decimal(callData.b[0][1]), decimal(callData.b[0][0])],
      [decimal(callData.b[1][1]), decimal(callData.b[1][0])],
      ["1", "0"],
    ],
    pi_c: [decimal(callData.c[0]), decimal(callData.c[1]), "1"],
    protocol: "groth16",
    curve: "bn128",
  };
}

/// The twenty-four words are nine G1 commitments followed by six evaluations, in the
/// order `plonkExportSolidityCallData` writes them. Every commitment is affine over the
/// base field, so nothing is reordered and nothing gains a projective coordinate.
const PLONK_COMMITMENTS = ["A", "B", "C", "Z", "T1", "T2", "T3", "Wxi", "Wxiw"] as const;
const PLONK_EVALUATIONS = ["eval_a", "eval_b", "eval_c", "eval_s1", "eval_s2", "eval_zw"] as const;

export const PLONK_PROOF_WORDS = PLONK_COMMITMENTS.length * 2 + PLONK_EVALUATIONS.length;

export function plonkCallDataToProof(callData: PlonkCallData): PlonkProof {
  const words = callData.proof.map(decimal);
  const proof: Record<string, unknown> = { protocol: "plonk", curve: "bn128" };

  PLONK_COMMITMENTS.forEach((name, index) => {
    proof[name] = [words[index * 2]!, words[index * 2 + 1]!, "1"];
  });
  PLONK_EVALUATIONS.forEach((name, index) => {
    proof[name] = words[PLONK_COMMITMENTS.length * 2 + index]!;
  });

  return proof as unknown as PlonkProof;
}

function isGroth16CallData(callData: ProofCallData): callData is Groth16CallData {
  return "a" in callData && "b" in callData && "c" in callData;
}

function isPlonkCallData(callData: ProofCallData): callData is PlonkCallData {
  return "proof" in callData && Array.isArray((callData as PlonkCallData).proof);
}

const groth16Codec: ProofCodec = {
  scheme: "groth16",
  proofWords: 8,
  accepts: isGroth16CallData,
  toSnarkjsProof: (callData) => groth16CallDataToProof(callData as Groth16CallData),
  async verify(verificationKey, callData) {
    return groth16.verify(
      verificationKey,
      publicSignalsOf(callData).map(decimal),
      groth16CallDataToProof(callData as Groth16CallData),
    );
  },
};

/// snarkjs reports a malformed PLONK commitment through the logger it was handed, and
/// reaches for it without checking that one was. A silent logger turns what would be a
/// crash on caller-supplied bytes into the `false` the caller is owed.
const silentLogger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

const plonkCodec: ProofCodec = {
  scheme: "plonk",
  proofWords: PLONK_PROOF_WORDS,
  accepts: isPlonkCallData,
  toSnarkjsProof: (callData) => plonkCallDataToProof(callData as PlonkCallData),
  async verify(verificationKey, callData) {
    return plonk.verify(
      verificationKey,
      publicSignalsOf(callData).map(decimal),
      plonkCallDataToProof(callData as PlonkCallData),
      silentLogger,
    );
  },
};

const codecs: Record<ProofScheme, ProofCodec> = { groth16: groth16Codec, plonk: plonkCodec };

export function codecFor(scheme: ProofScheme): ProofCodec {
  return codecs[scheme];
}

export function publicSignalsOf(callData: ProofCallData): PublicSignalTuple {
  return callData.signals;
}

/// Which scheme wrote this payload, read off its shape alone. `null` for anything that
/// is neither, which the caller turns into a refusal rather than a guess.
export function schemeOf(callData: ProofCallData): ProofScheme | null {
  if (isGroth16CallData(callData)) return "groth16";
  if (isPlonkCallData(callData)) return "plonk";
  return null;
}
