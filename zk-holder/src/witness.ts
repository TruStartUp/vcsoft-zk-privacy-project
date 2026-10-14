import { credentialCommitment, credentialNullifier } from "./credential.js";
import { CREDENTIAL_TREE_DEPTH, JURISDICTION_TREE_DEPTH } from "./field.js";
import { rootFromOpening, type MerkleOpening } from "./merkle.js";
import { poseidonHash } from "./poseidon.js";
import { holderSecretHash } from "./secret.js";

/// `GET /v1/credentials/:commitment/opening`
export interface CredentialOpeningResponse {
  commitment: string;
  leafIndex: number;
  credentialRoot: string;
  opening: MerkleOpening;
}

/// `GET /v1/assets/:assetId/jurisdictions/:countryCode/opening`
export interface JurisdictionOpeningResponse {
  assetId: string;
  countryCode: number;
  leafIndex: number;
  countryRoot: string;
  opening: MerkleOpening;
}

export interface WitnessParameters {
  secret: bigint;
  countryCode: number;
  expiry: bigint;
  assetId: bigint;
  /// `currentEpochEnd + epochLength`, so the proof does not cross a period boundary in flight.
  epochEnd: bigint;
  /// `ComplianceAttestor.anchorFor(subject)`, read from the chain for the investor's address.
  anchor: bigint;
  credential: CredentialOpeningResponse;
  jurisdiction: JurisdictionOpeningResponse;
}

export type CircuitInput = Record<string, string | string[]>;

export interface Witness {
  input: CircuitInput;
  nullifier: bigint;
  commitment: bigint;
}

export class WitnessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/// Builds the circuit input and, unless told otherwise, checks it the way the
/// circuit will, so an inconsistent opening is named here instead of surfacing as
/// an assertion deep in witness generation.
export async function buildWitness(params: WitnessParameters, options: { check?: boolean } = {}): Promise<Witness> {
  const check = options.check ?? true;
  const hash = await poseidonHash();
  const secretHash = await holderSecretHash(params.secret);
  const commitment = await credentialCommitment(secretHash, params.countryCode, params.expiry);
  const nullifier = await credentialNullifier(params.secret, params.assetId, params.epochEnd);

  if (check) {
    if (commitment.toString() !== params.credential.commitment) {
      throw new WitnessError("commitment_mismatch", "the opening belongs to another commitment");
    }
    const credentialRoot = rootFromOpening(hash, commitment, params.credential.opening, CREDENTIAL_TREE_DEPTH);
    if (credentialRoot.toString() !== params.credential.credentialRoot) {
      throw new WitnessError("credential_root_mismatch", "the credential opening does not reach its root");
    }
    if (params.jurisdiction.countryCode !== params.countryCode) {
      throw new WitnessError("jurisdiction_mismatch", "the jurisdiction opening is for another country");
    }
    const countryRoot = rootFromOpening(hash, BigInt(params.countryCode), params.jurisdiction.opening, JURISDICTION_TREE_DEPTH);
    if (countryRoot.toString() !== params.jurisdiction.countryRoot) {
      throw new WitnessError("country_root_mismatch", "the jurisdiction opening does not reach its root");
    }
    if (params.expiry < params.epochEnd) {
      throw new WitnessError("credential_expires_in_period", "the credential expires before the period claimed ends");
    }
  }

  return {
    commitment,
    nullifier,
    input: {
      credentialRoot: params.credential.credentialRoot,
      countryRoot: params.jurisdiction.countryRoot,
      assetId: params.assetId.toString(),
      epochEnd: params.epochEnd.toString(),
      nullifier: nullifier.toString(),
      anchor: params.anchor.toString(),
      secret: params.secret.toString(),
      country: String(params.countryCode),
      expiry: params.expiry.toString(),
      credentialPathElements: params.credential.opening.pathElements,
      credentialPathIndices: params.credential.opening.pathIndices,
      countryPathElements: params.jurisdiction.opening.pathElements,
      countryPathIndices: params.jurisdiction.opening.pathIndices,
    },
  };
}
