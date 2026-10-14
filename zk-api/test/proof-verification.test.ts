import type { Express } from "express";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/registry.service.js", () => import("./helpers/registry-stub.js"));

import { createApp } from "../src/app.js";
import { FIELD_ORDER } from "../src/lib/field.js";
import { groth16CallDataToProof, type Groth16CallData, type PublicSignalTuple } from "../src/lib/proof-codec.js";
import { prisma } from "../src/lib/prisma.js";
import { createPartner } from "../src/services/partner.service.js";
import {
  parsePublicSignals,
  resetVerificationKeyCache,
  verificationStanding,
  verifyProof,
} from "../src/services/proof-verification.service.js";
import { resetDatabase } from "./helpers/database.js";
import { resetRegistryStub, state } from "./helpers/registry-stub.js";
import { signedRequest } from "./helpers/signed-request.js";

interface Fixture {
  meta: { currentEpochEnd: string; nextEpochEnd: string; assetA: string; assetB: string };
  roots: { credentialCurrent: string; countryA: string; countryB: string };
  proofs: Record<string, Groth16CallData & { sender: string; epochEnd: string }>;
}

let app: Express;
let fixture: Fixture;

/// The registry state these proofs were generated against. Verifying a proof is
/// only half the answer; the other half is whether the roots and the period it
/// names are the ones the chain currently holds.
function seedRegistryFor(fixtureData: Fixture): void {
  state.credentialRoot = BigInt(fixtureData.roots.credentialCurrent);
  state.countryRoots.set(fixtureData.meta.assetA, BigInt(fixtureData.roots.countryA));
  state.countryRoots.set(fixtureData.meta.assetB, BigInt(fixtureData.roots.countryB));
  state.currentEpochEnd = BigInt(fixtureData.meta.currentEpochEnd);
  state.epochLength = 2_592_000n;
}

beforeAll(async () => {
  app = createApp();
  fixture = JSON.parse(
    await readFile(resolve(import.meta.dirname, "fixtures/compliance-proofs.json"), "utf8"),
  ) as Fixture;
});

beforeEach(async () => {
  await resetDatabase();
  resetRegistryStub();
  resetVerificationKeyCache();
  seedRegistryFor(fixture);
});

describe("reading a proof off the calldata the platform submits", () => {
  /// `exportSolidityCallData` swaps each Fp2 coordinate pair of B for the pairing
  /// precompile. Feeding the calldata back to snarkjs unswapped verifies a
  /// different point and answers false for a perfectly good proof.
  it("undoes the coordinate swap the Solidity encoding applies", () => {
    const callData = fixture.proofs.aliceCurrent!;
    const proof = groth16CallDataToProof(callData);

    expect(proof.pi_b[0]![0]).toBe(BigInt(callData.b[0][1]).toString(10));
    expect(proof.pi_b[0]![1]).toBe(BigInt(callData.b[0][0]).toString(10));
    expect(proof.pi_a[2]).toBe("1");
  });

  it("reads the six public signals in the order the circuit declares them", () => {
    const signals = parsePublicSignals(fixture.proofs.aliceCurrent!.signals);
    expect(signals.assetId).toBe(42n);
    expect(signals.epochEnd).toBe(BigInt(fixture.meta.currentEpochEnd));
    expect(signals.credentialRoot).toBe(BigInt(fixture.roots.credentialCurrent));
    expect(signals.countryRoot).toBe(BigInt(fixture.roots.countryA));
  });

  it("refuses a signal that is not an integer at all", () => {
    const signals = fixture.proofs.aliceCurrent!.signals.slice() as PublicSignalTuple;
    signals[4] = "not-a-number";
    expect(() => parsePublicSignals(signals)).toThrow(/is not an integer/);
  });

  it("refuses a signal count the circuit does not have", () => {
    expect(() => parsePublicSignals(["1", "2", "3"])).toThrow(/six public signals|6 public signals/);
  });
});

describe("validating a proof", () => {
  it("accepts a real proof against the state it was built for", async () => {
    const outcome = await verifyProof(fixture.proofs.aliceCurrent!);

    expect(outcome.valid).toBe(true);
    expect(outcome.rejectionCode).toBeNull();
    expect(outcome.publicSignals.assetId).toBe("42");
  });

  it("accepts two different holders on the same asset", async () => {
    expect((await verifyProof(fixture.proofs.aliceCurrent!)).valid).toBe(true);
    expect((await verifyProof(fixture.proofs.bobCurrent!)).valid).toBe(true);
  });

  it("refuses a proof whose A point was moved", async () => {
    const tampered = structuredClone(fixture.proofs.aliceCurrent!);
    tampered.a[0] = `0x${(BigInt(tampered.a[0]) + 1n).toString(16)}`;

    const outcome = await verifyProof(tampered);
    expect(outcome.valid).toBe(false);
    expect(outcome.rejectionCode).toBe("invalid_proof");
  });

  it("refuses a proof whose public signals were edited under it", async () => {
    const tampered = structuredClone(fixture.proofs.aliceCurrent!);
    tampered.signals[2] = "0x2b";

    const outcome = await verifyProof(tampered);
    expect(outcome.valid).toBe(false);
    expect(outcome.rejectionCode).toBe("invalid_proof");
  });

  it("refuses a signal outside the field before it touches the pairing check", async () => {
    const tampered = structuredClone(fixture.proofs.aliceCurrent!);
    tampered.signals[4] = `0x${(BigInt(tampered.signals[4]) + FIELD_ORDER).toString(16)}`;

    const outcome = await verifyProof(tampered);
    expect(outcome.valid).toBe(false);
    expect(outcome.rejectionCode).toBe("public_signal_out_of_field");
  });

  /// A sound proof against a root the registry has dropped is not a compliant
  /// operation: this is where a revocation actually bites.
  it("refuses a sound proof once its credential root is no longer accepted", async () => {
    state.credentialRoot = 999n;
    const outcome = await verifyProof(fixture.proofs.aliceCurrent!);

    expect(outcome.valid).toBe(false);
    expect(outcome.rejectionCode).toBe("credential_root_not_valid");
  });

  it("accepts a sound proof against a superseded root while the window is open", async () => {
    const supersededRoot = state.credentialRoot;
    state.credentialRoot = 999n;
    state.supersededCredentialRoots.add(supersededRoot.toString());

    expect((await verifyProof(fixture.proofs.aliceCurrent!)).valid).toBe(true);
  });

  it("refuses a proof for an asset with no jurisdiction root published", async () => {
    state.countryRoots.delete(fixture.meta.assetA);
    const outcome = await verifyProof(fixture.proofs.aliceCurrent!);

    expect(outcome.valid).toBe(false);
    expect(outcome.rejectionCode).toBe("asset_not_registered");
  });

  it("refuses a proof naming another asset's jurisdiction root", async () => {
    const outcome = await verifyProof(fixture.proofs.aliceOnAssetB!);
    expect(outcome.valid).toBe(true);

    state.countryRoots.set(fixture.meta.assetB, 12345n);
    const second = await verifyProof(fixture.proofs.aliceOnAssetB!);
    expect(second.rejectionCode).toBe("country_root_not_valid");
  });

  it("refuses a period that is neither the running one nor the next", async () => {
    state.currentEpochEnd = BigInt(fixture.meta.currentEpochEnd) + 10n * 2_592_000n;
    const outcome = await verifyProof(fixture.proofs.aliceCurrent!);

    expect(outcome.valid).toBe(false);
    expect(outcome.rejectionCode).toBe("epoch_end_not_claimable");
  });

  it("accepts the next period, so a holder can renew before the running one closes", async () => {
    state.currentEpochEnd = BigInt(fixture.meta.currentEpochEnd) - 2_592_000n;
    expect((await verifyProof(fixture.proofs.aliceCurrent!)).valid).toBe(true);
  });

  it("refuses a nullifier the attestor already spent", async () => {
    const nullifier = BigInt(fixture.proofs.aliceCurrent!.signals[4]).toString();
    state.spentNullifiers.add(nullifier);

    const outcome = await verifyProof(fixture.proofs.aliceCurrent!);
    expect(outcome.valid).toBe(false);
    expect(outcome.rejectionCode).toBe("nullifier_already_spent");
  });

  /// Nothing is invented when the answer cannot be computed: without the
  /// verifying key there is no verdict to give.
  it("fails loudly when the verifying key is not readable", async () => {
    await expect(
      verifyProof(fixture.proofs.aliceCurrent!, undefined, {
        scheme: "groth16",
        verificationKeyPath: "test/fixtures/there-is-no-key.json",
      }),
    ).rejects.toMatchObject({
      output: { payload: { code: "verification_key_unavailable" } },
    });
  });

  it("keeps every verdict, refusals included", async () => {
    await verifyProof(fixture.proofs.aliceCurrent!);
    state.credentialRoot = 999n;
    await verifyProof(fixture.proofs.bobCurrent!);

    const records = await prisma.proofVerification.findMany({ orderBy: { verifiedAt: "asc" } });
    expect(records).toHaveLength(2);
    expect(records[0]!.valid).toBe(true);
    expect(records[1]!).toMatchObject({ valid: false, rejectionCode: "credential_root_not_valid" });
  });
});

describe("asking later whether a proof still stands", () => {
  it("reports a live attestation while its period is open and its root current", async () => {
    const outcome = await verifyProof(fixture.proofs.aliceCurrent!);
    const standing = await verificationStanding(outcome.id);

    expect(standing.standing).toBe("live");
    expect(standing.credentialRootStillValid).toBe(true);
    expect(standing.nullifierSpent).toBe(false);
  });

  it("reports it superseded once the root behind it is dropped", async () => {
    const outcome = await verifyProof(fixture.proofs.aliceCurrent!);
    state.credentialRoot = 999n;

    expect((await verificationStanding(outcome.id)).standing).toBe("superseded_root");
  });

  it("reports one that never verified as never valid", async () => {
    state.credentialRoot = 999n;
    const outcome = await verifyProof(fixture.proofs.aliceCurrent!);

    expect((await verificationStanding(outcome.id)).standing).toBe("never_valid");
  });

  it("does not invent a verification that was never recorded", async () => {
    await expect(verificationStanding("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      output: { payload: { code: "verification_not_found" } },
    });
  });
});

describe("the verification routes", () => {
  it("validates a proof for a bank holding the scope and answers on its standing", async () => {
    const bank = await createPartner("bank-core", ["proofs:verify", "proofs:read"]);

    const validation = await signedRequest(app, {
      method: "post",
      path: "/v1/verifications",
      partnerKey: bank.partnerKey,
      secret: bank.secret,
      body: { proof: fixture.proofs.aliceCurrent },
    });

    expect(validation.status).toBe(201);
    expect(validation.body).toMatchObject({ valid: true, rejectionCode: null });

    const standing = await signedRequest(app, {
      method: "get",
      path: `/v1/verifications/${validation.body.id}`,
      partnerKey: bank.partnerKey,
      secret: bank.secret,
    });

    expect(standing.status).toBe(200);
    expect(standing.body.standing).toBe("live");
  });

  /// The whole point of the layer: the bank learns whether the operation
  /// complies, and nothing about who is behind it.
  it("answers the compliance question without a single personal attribute", async () => {
    const bank = await createPartner("bank-core", ["compliance:read"]);
    state.attestations.set(`42/0x90f79bf6eb2c4f870365e785982e1f101e93b906`, {
      issuedAt: 1_700_000_000n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400),
      nullifier: 12345n,
    });

    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/compliance/assets/42/subjects/0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      partnerKey: bank.partnerKey,
      secret: bank.secret,
    });

    expect(response.status).toBe(200);
    expect(response.body.compliant).toBe(true);

    const body = JSON.stringify(response.body);
    for (const forbidden of ["legalName", "documentNumber", "countryCode", "commitment", "kyc"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("refuses to answer on an asset with no jurisdiction root", async () => {
    const bank = await createPartner("bank-core", ["compliance:read"]);
    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/compliance/assets/99/subjects/0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      partnerKey: bank.partnerKey,
      secret: bank.secret,
    });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("asset_not_registered");
  });
});
