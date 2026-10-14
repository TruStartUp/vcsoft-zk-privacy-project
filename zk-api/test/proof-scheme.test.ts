import type { Express } from "express";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/registry.service.js", () => import("./helpers/registry-stub.js"));

import { createApp } from "../src/app.js";
import {
  PLONK_PROOF_WORDS,
  groth16CallDataToProof,
  plonkCallDataToProof,
  schemeOf,
  type Groth16CallData,
  type PlonkCallData,
} from "../src/lib/proof-codec.js";
import { prisma } from "../src/lib/prisma.js";
import { createPartner } from "../src/services/partner.service.js";
import {
  verificationStanding,
  verifyProof,
  type ProofBackend,
} from "../src/services/proof-verification.service.js";
import { resetDatabase } from "./helpers/database.js";
import { resetRegistryStub, state } from "./helpers/registry-stub.js";
import { signedRequest } from "./helpers/signed-request.js";

/// The delivery record promises the proving scheme can be replaced without redesigning
/// the solution. On chain that is the verifier adapter; here it is this: how a proof is
/// written down lives in one module, and everything above it -- the verification
/// service, the routes, the access log, the standing of a verdict -- is told which
/// scheme applies and never learns what the difference is.
///
/// The fixtures are the same witness proved twice. The public signals are byte for byte
/// identical across the two, which is the whole point: the statement does not change,
/// only the machinery that checks it.

interface Fixture {
  meta: { currentEpochEnd: string; assetA: string; assetB: string };
  roots: { credentialCurrent: string; countryA: string; countryB: string };
  proofs: Record<string, Groth16CallData & { sender: string }>;
  plonkProofs: Record<string, PlonkCallData & { sender: string }>;
}

const PLONK_BACKEND: ProofBackend = { scheme: "plonk", verificationKeyPath: "test/fixtures/plonk.vkey.json" };
const GROTH16_BACKEND: ProofBackend = { scheme: "groth16", verificationKeyPath: "test/fixtures/groth16.vkey.json" };

let app: Express;
let fixture: Fixture;

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
  seedRegistryFor(fixture);
});

describe("what each scheme's calldata says, and how it is read back", () => {
  it("undoes the Fp2 coordinate swap Groth16's Solidity encoding applies", () => {
    const callData = fixture.proofs.aliceCurrent!;
    const proof = groth16CallDataToProof(callData);

    expect(proof.pi_b[0]![0]).toBe(BigInt(callData.b[0][1]).toString(10));
    expect(proof.pi_b[0]![1]).toBe(BigInt(callData.b[0][0]).toString(10));
  });

  /// The swap is a Groth16 detail: `B` is the only commitment over Fp2 in either
  /// scheme, and PLONK has none. Its twenty-four words are read straight through, which
  /// is exactly the kind of difference a boundary exists to absorb.
  it("reorders nothing in PLONK, whose commitments are all over the base field", () => {
    const callData = fixture.plonkProofs.aliceCurrent!;
    const proof = plonkCallDataToProof(callData);
    const word = (index: number) => BigInt(callData.proof[index]!).toString(10);

    expect(callData.proof).toHaveLength(PLONK_PROOF_WORDS);
    expect(proof.A[0]).toBe(word(0));
    expect(proof.A[1]).toBe(word(1));
    expect(proof.Wxiw[0]).toBe(word(16));
    expect(proof.Wxiw[1]).toBe(word(17));
    expect(proof.eval_a).toBe(word(18));
    expect(proof.eval_zw).toBe(word(23));
  });

  it("tells the two payloads apart by their shape alone", () => {
    expect(schemeOf(fixture.proofs.aliceCurrent!)).toBe("groth16");
    expect(schemeOf(fixture.plonkProofs.aliceCurrent!)).toBe("plonk");
    expect(schemeOf({ signals: fixture.proofs.aliceCurrent!.signals } as never)).toBeNull();
  });

  it("the same statement travels in both, signal for signal", () => {
    for (const label of Object.keys(fixture.proofs)) {
      expect(fixture.plonkProofs[label]!.signals, label).toEqual(fixture.proofs[label]!.signals);
    }
  });
});

describe("verifying under either scheme", () => {
  it("reaches the same verdict on the same witness with PLONK as with Groth16", async () => {
    const withGroth16 = await verifyProof(fixture.proofs.aliceCurrent!, undefined, GROTH16_BACKEND);
    const withPlonk = await verifyProof(fixture.plonkProofs.aliceCurrent!, undefined, PLONK_BACKEND);

    expect(withGroth16.valid).toBe(true);
    expect(withPlonk.valid).toBe(true);
    expect(withPlonk.rejectionCode).toBeNull();
    expect(withPlonk.publicSignals).toEqual(withGroth16.publicSignals);
    expect(withPlonk.scheme).toBe("plonk");
    expect(withGroth16.scheme).toBe("groth16");
  });

  it("applies the same chain-state checks to a PLONK proof", async () => {
    state.credentialRoot = 999n;

    const outcome = await verifyProof(fixture.plonkProofs.aliceCurrent!, undefined, PLONK_BACKEND);
    expect(outcome.valid).toBe(false);
    expect(outcome.rejectionCode).toBe("credential_root_not_valid");
  });

  it("refuses a PLONK proof whose body was edited under it", async () => {
    const tampered = structuredClone(fixture.plonkProofs.aliceCurrent!);
    tampered.proof[18] = `0x${(BigInt(tampered.proof[18]!) + 1n).toString(16).padStart(64, "0")}`;

    const outcome = await verifyProof(tampered, undefined, PLONK_BACKEND);
    expect(outcome.valid).toBe(false);
    expect(outcome.rejectionCode).toBe("invalid_proof");
  });

  /// A commitment that is not a point on the curve is caller-supplied nonsense, and the
  /// answer to it is a verdict, not a stack trace.
  it("refuses a PLONK commitment that is not on the curve without falling over", async () => {
    const tampered = structuredClone(fixture.plonkProofs.aliceCurrent!);
    tampered.proof[0] = `0x${(7n).toString(16).padStart(64, "0")}`;

    const outcome = await verifyProof(tampered, undefined, PLONK_BACKEND);
    expect(outcome.valid).toBe(false);
    expect(outcome.rejectionCode).toBe("invalid_proof");
  });

  /// A key from the other scheme is a misconfigured deployment, not a bad proof, and it
  /// would otherwise turn every honest proof into `invalid_proof` with nothing to
  /// suggest where to look.
  it("names a verifying key from the other scheme as the misconfiguration it is", async () => {
    await expect(
      verifyProof(fixture.plonkProofs.aliceCurrent!, undefined, {
        scheme: "plonk",
        verificationKeyPath: "test/fixtures/groth16.vkey.json",
      }),
    ).rejects.toMatchObject({ output: { payload: { code: "verification_key_scheme_mismatch" } } });

    await expect(
      verifyProof(fixture.proofs.aliceCurrent!, undefined, {
        scheme: "groth16",
        verificationKeyPath: "test/fixtures/plonk.vkey.json",
      }),
    ).rejects.toMatchObject({ output: { payload: { code: "verification_key_scheme_mismatch" } } });

    expect(await prisma.proofVerification.count()).toBe(0);
  });

  it("records which scheme reached the verdict, and answers with it later", async () => {
    const outcome = await verifyProof(fixture.plonkProofs.bobCurrent!, undefined, PLONK_BACKEND);

    const record = await prisma.proofVerification.findUniqueOrThrow({ where: { id: outcome.id } });
    expect(record.scheme).toBe("plonk");
    expect((await verificationStanding(outcome.id)).scheme).toBe("plonk");
  });
});

describe("the scheme this deployment actually verifies", () => {
  /// The suite runs the routes under Groth16, which is what the environment names.
  it("refuses a payload of the other scheme instead of calling it invalid", async () => {
    await expect(verifyProof(fixture.plonkProofs.aliceCurrent!)).rejects.toMatchObject({
      output: { payload: { code: "proof_scheme_mismatch" } },
    });

    expect(await prisma.proofVerification.count()).toBe(0);
  });

  it("says so over HTTP, with the scheme it does verify named", async () => {
    const bank = await createPartner("bank-core", ["proofs:verify", "proofs:read"]);

    const response = await signedRequest(app, {
      method: "post",
      path: "/v1/verifications",
      partnerKey: bank.partnerKey,
      secret: bank.secret,
      body: { proof: fixture.plonkProofs.aliceCurrent },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("proof_scheme_mismatch");
    expect(response.body.details).toMatchObject({ expected: "groth16", received: "plonk" });
  });

  it("still validates the scheme it does verify, end to end", async () => {
    const bank = await createPartner("bank-core", ["proofs:verify", "proofs:read"]);

    const response = await signedRequest(app, {
      method: "post",
      path: "/v1/verifications",
      partnerKey: bank.partnerKey,
      secret: bank.secret,
      body: { proof: fixture.proofs.aliceCurrent },
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ valid: true, scheme: "groth16" });
  });

  it("refuses a payload that is neither scheme before it reaches the service", async () => {
    const bank = await createPartner("bank-core", ["proofs:verify"]);

    const response = await signedRequest(app, {
      method: "post",
      path: "/v1/verifications",
      partnerKey: bank.partnerKey,
      secret: bank.secret,
      body: { proof: { signals: fixture.proofs.aliceCurrent!.signals } },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("validation_failed");
  });
});
