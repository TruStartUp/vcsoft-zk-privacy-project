/// The proving schemes this deployment can be configured for. Kept apart from the
/// codecs so that reading the configuration does not pull the proving library in.
export const PROOF_SCHEMES = ["groth16", "plonk"] as const;

export type ProofScheme = (typeof PROOF_SCHEMES)[number];
