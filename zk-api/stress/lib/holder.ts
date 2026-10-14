import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import * as snarkjs from "snarkjs";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { readProvingContext } from "../../../zk-holder/src/chain.js";
import { credentialCommitment, expiryOf } from "../../../zk-holder/src/credential.js";
import { signActivation } from "../../../zk-holder/src/possession.js";
import { circuitArtifacts, proveCompliance, releaseProver } from "../../../zk-holder/src/prover.js";
import { generateHolderSecret, holderSecretHash } from "../../../zk-holder/src/secret.js";
import { buildWitness, type CredentialOpeningResponse, type JurisdictionOpeningResponse } from "../../../zk-holder/src/witness.js";
import type { StressClient } from "./client.js";
import { REPO_DIR } from "./env.js";

export const ARTIFACTS = circuitArtifacts(resolve(REPO_DIR, "zk-circuits/build"));
export const PLONK_ZKEY = resolve(REPO_DIR, "zk-circuits/build/plonk.zkey");
export { releaseProver };

export interface DeploymentDomain {
  chainId: number;
  credentialRegistry: Address;
}

export interface Holder {
  account: PrivateKeyAccount;
  privateKey: `0x${string}`;
  secret: bigint;
  secretHash: bigint;
  countryCode: number;
  kycSubjectId: string;
  credentialId?: string;
  expiresAt?: string;
  commitment?: string;
  leafIndex?: number;
}

export async function newHolder(countryCode = 170): Promise<Holder> {
  const secret = generateHolderSecret();
  const privateKey = generatePrivateKey();
  return {
    account: privateKeyToAccount(privateKey),
    privateKey,
    secret,
    secretHash: await holderSecretHash(secret),
    countryCode,
    kycSubjectId: `stress-${randomUUID()}`,
  };
}

export function verificationBody(holder: Holder, validForDays = 400) {
  const expiresAt = new Date(Math.floor(Date.now() / 1000 + validForDays * 86_400) * 1000).toISOString();
  return {
    kycSubjectId: holder.kycSubjectId,
    holderAddress: holder.account.address,
    verification: { approved: true, countryCode: holder.countryCode, expiresAt, reference: `stress-${holder.kycSubjectId}` },
    identity: {
      legalName: "Stress test subject (fictitious)",
      documentType: "TEST-ID",
      documentNumber: holder.kycSubjectId,
      countryCode: holder.countryCode,
    },
  };
}

/// Step one of issuance, as the bank's integration sends it.
export async function register(client: StressClient, holder: Holder) {
  const reply = await client.post("/v1/credentials", verificationBody(holder));
  if (reply.status === 201) {
    holder.credentialId = reply.body.credentialId;
    holder.expiresAt = reply.body.expiresAt;
  }
  return reply;
}

/// Step two: the holder's wallet signs possession and hands over only the hash.
export async function activate(client: StressClient, holder: Holder, domain: DeploymentDomain) {
  const signature = await signActivation(holder.account, domain, holder.credentialId!, holder.secretHash);
  const reply = await client.post(`/v1/credentials/${holder.credentialId}/activation`, {
    secretHash: holder.secretHash.toString(),
    signature,
  });
  if (reply.status === 201) {
    holder.commitment = reply.body.commitment;
    holder.leafIndex = reply.body.leafIndex;
    const expected = await credentialCommitment(holder.secretHash, holder.countryCode, expiryOf(holder.expiresAt!));
    if (expected.toString() !== reply.body.commitment) throw new Error("the issuer published a commitment the holder does not compute");
  }
  return reply;
}

export async function expectedCommitment(holder: Holder): Promise<bigint> {
  return credentialCommitment(holder.secretHash, holder.countryCode, expiryOf(holder.expiresAt!));
}

export function chainClient(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
}

export interface Prover {
  fullProve(input: unknown, wasm: string, zkey: string): Promise<{ proof: unknown; publicSignals: string[] }>;
  exportSolidityCallData(proof: unknown, publicSignals: string[]): Promise<string>;
}

export interface ProofInput {
  input: Record<string, string | string[]>;
  nullifier: bigint;
}

/// The holder's side of a proof: openings from the issuer, the period and anchor from
/// the attestor, and the witness checked before proving.
export async function witnessFor(
  client: StressClient,
  holder: Holder,
  chain: PublicClient,
  attestor: Address,
  assetId: bigint,
): Promise<ProofInput> {
  const credential = await client.get<CredentialOpeningResponse>(`/v1/credentials/${holder.commitment}/opening`);
  if (credential.status !== 200) throw new Error(`credential opening answered ${credential.status}`);
  const jurisdiction = await client.get<JurisdictionOpeningResponse>(`/v1/assets/${assetId}/jurisdictions/${holder.countryCode}/opening`);
  if (jurisdiction.status !== 200) throw new Error(`jurisdiction opening answered ${jurisdiction.status}`);
  const context = await readProvingContext(chain, attestor, holder.account.address);
  const witness = await buildWitness({
    secret: holder.secret,
    countryCode: holder.countryCode,
    expiry: expiryOf(holder.expiresAt!),
    assetId,
    epochEnd: context.epochEnd,
    anchor: context.anchor,
    credential: credential.body,
    jurisdiction: jurisdiction.body,
  });
  return { input: witness.input, nullifier: witness.nullifier };
}

export async function groth16CallData(witness: ProofInput) {
  return (await proveCompliance(witness.input, ARTIFACTS)).callData;
}

export async function plonkCallData(witness: ProofInput) {
  const plonk = (snarkjs as unknown as { plonk: Prover }).plonk;
  const { proof, publicSignals } = await plonk.fullProve(witness.input, ARTIFACTS.wasmPath, PLONK_ZKEY);
  const raw = await plonk.exportSolidityCallData(proof, publicSignals);
  const [body, signals] = JSON.parse(`[${raw.replace(/\]\s*\[/g, "],[")}]`) as [string[], string[]];
  return { proof: body, signals };
}
