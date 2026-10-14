import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { AbiCoder } from "ethers";
import { ethers } from "hardhat";

import fixtureData from "./fixtures/compliance-proofs.json";

export const fixture = fixtureData;

export const SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const NOW = fixtureData.meta.referenceTimestamp;
export const EPOCH_LENGTH = fixtureData.meta.epochLength;
export const CURRENT_EPOCH_END = Number(fixtureData.meta.currentEpochEnd);
export const NEXT_EPOCH_END = Number(fixtureData.meta.nextEpochEnd);
export const PAST_EPOCH_END = Number(fixtureData.meta.pastEpochEnd);
export const FAR_FUTURE_EPOCH_END = Number(fixtureData.meta.farFutureEpochEnd);
export const MISALIGNED_EPOCH_END = Number(fixtureData.meta.misalignedEpochEnd);

export const ROOT_SUPERSEDED_AT = NOW - 60;
export const ROOT_VALIDITY_WINDOW = 15 * 60;

export const ASSET_A = BigInt(fixtureData.meta.assetA);
export const ASSET_B = BigInt(fixtureData.meta.assetB);

export type Groth16ProofFixture = {
  a: string[];
  b: string[][];
  c: string[];
  signals: string[];
  sender: string;
  epochEnd: string;
};

export type PlonkProofFixture = {
  proof: string[];
  signals: string[];
  sender: string;
  epochEnd: string;
};

export type ProofFixture = Groth16ProofFixture | PlonkProofFixture;

export const proofs = fixtureData.proofs as unknown as Record<string, Groth16ProofFixture>;
export const plonkProofs = fixtureData.plonkProofs as unknown as Record<string, PlonkProofFixture>;

const coder = AbiCoder.defaultAbiCoder();

/// The attestor takes the proof as opaque bytes and never learns which scheme wrote
/// them. This is the only place in the suite that knows, and it is the mirror of what
/// each adapter decodes on the other side of the boundary.
export function proofBody(proof: ProofFixture): string {
  return "proof" in proof
    ? coder.encode(["uint256[24]"], [proof.proof])
    : coder.encode(["uint256[2]", "uint256[2][2]", "uint256[2]"], [proof.a, proof.b, proof.c]);
}

export const credentialLeafArgs = (leaves: { leafIndex: number; commitment: string }[], inserted: boolean) =>
  leaves.map((leaf) => ({ leafIndex: leaf.leafIndex, commitment: BigInt(leaf.commitment), inserted }));

export const countryLeafArgs = (leaves: { leafIndex: number; countryCode: number }[], admitted: boolean) =>
  leaves.map((leaf) => ({ leafIndex: leaf.leafIndex, countryCode: leaf.countryCode, admitted }));

/// Every fixture proof carries an anchor computed for one sender and for the attestor
/// this stack is about to deploy. Both are deterministic, and a proof built against
/// either of them is worthless anywhere else, so a drift in the deployment order has to
/// stop the suite here instead of surfacing as a wall of AnchorMismatch.
async function requireFixtureStillApplies(attestorAddress: string) {
  const { chainId } = await ethers.provider.getNetwork();
  expect(String(chainId), "regenerate the fixture: node test/fixtures/generate-proofs.mjs").to.equal(
    fixture.meta.chainId,
  );
  expect(attestorAddress, "regenerate the fixture: node test/fixtures/generate-proofs.mjs").to.equal(
    fixture.meta.attestorAddress,
  );
}

export async function deployComplianceStack() {
  const [admin, issuer, jurisdiction, alice, bob, outsider, carla, platform] = await ethers.getSigners();

  const registry = await (await ethers.getContractFactory("CredentialRegistry")).deploy(
    admin.address,
    ROOT_VALIDITY_WINDOW,
  );
  const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
  const groth16Adapter = await (await ethers.getContractFactory("Groth16VerifierAdapter")).deploy(
    await verifier.getAddress(),
  );
  const attestor = await (await ethers.getContractFactory("ComplianceAttestor")).deploy(
    admin.address,
    await registry.getAddress(),
    await groth16Adapter.getAddress(),
    EPOCH_LENGTH,
  );
  await requireFixtureStillApplies(await attestor.getAddress());

  // Deployed after the attestor on purpose: the anchor every fixture proof carries is
  // computed from the attestor's address, and only the contracts before it move it.
  const plonkVerifier = await (await ethers.getContractFactory("PlonkVerifier")).deploy();
  const plonkAdapter = await (await ethers.getContractFactory("PlonkVerifierAdapter")).deploy(
    await plonkVerifier.getAddress(),
  );

  await registry.connect(admin).grantRole(await registry.ISSUER_ROLE(), issuer.address);
  await registry.connect(admin).grantRole(await registry.JURISDICTION_ROLE(), jurisdiction.address);
  await attestor.connect(admin).grantRole(await attestor.ATTESTATION_MANAGER_ROLE(), admin.address);

  await registry
    .connect(issuer)
    .publishCredentialRoot(
      BigInt(fixture.roots.credentialInitial),
      credentialLeafArgs(fixture.credentialLeaves.initial, true),
    );

  await time.setNextBlockTimestamp(ROOT_SUPERSEDED_AT);
  await registry
    .connect(issuer)
    .publishCredentialRoot(
      BigInt(fixture.roots.credentialCurrent),
      credentialLeafArgs(fixture.credentialLeaves.current, true),
    );

  await registry
    .connect(jurisdiction)
    .publishCountryRoot(ASSET_A, BigInt(fixture.roots.countryA), countryLeafArgs(fixture.countryLeaves.assetA, true));
  await registry
    .connect(jurisdiction)
    .publishCountryRoot(ASSET_B, BigInt(fixture.roots.countryB), countryLeafArgs(fixture.countryLeaves.assetB, true));

  const module = await (await ethers.getContractFactory("ZKComplianceModule")).deploy();
  await module.initialize(await attestor.getAddress());
  const moduleAddress = await module.getAddress();

  const complianceFactory = await ethers.getContractFactory("MockModularCompliance");
  const complianceA = await complianceFactory.deploy();
  await complianceA.bind(moduleAddress);
  await complianceA.setAssetId(moduleAddress, ASSET_A);

  const complianceB = await complianceFactory.deploy();
  await complianceB.bind(moduleAddress);
  await complianceB.setAssetId(moduleAddress, ASSET_B);

  const unconfiguredCompliance = await complianceFactory.deploy();
  await unconfiguredCompliance.bind(moduleAddress);

  return {
    admin,
    issuer,
    jurisdiction,
    alice,
    bob,
    outsider,
    carla,
    platform,
    registry,
    verifier,
    groth16Adapter,
    plonkVerifier,
    plonkAdapter,
    attestor,
    module,
    complianceA,
    complianceB,
    unconfiguredCompliance,
  };
}

export async function attestAt(
  attestor: any,
  signer: any,
  proof: ProofFixture,
  timestamp: number = NOW,
  signals: (string | bigint)[] = proof.signals,
) {
  await time.setNextBlockTimestamp(timestamp);
  return attestor.connect(signer).attest(proofBody(proof), signals);
}

export async function attestForAt(
  attestor: any,
  presenter: any,
  subject: string,
  proof: ProofFixture,
  timestamp: number = NOW,
  signals: (string | bigint)[] = proof.signals,
) {
  await time.setNextBlockTimestamp(timestamp);
  return attestor.connect(presenter).attestFor(subject, proofBody(proof), signals);
}
