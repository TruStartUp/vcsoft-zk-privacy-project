import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/registry.service.js", () => import("./helpers/registry-stub.js"));

import type { Groth16CallData } from "../src/lib/proof-codec.js";
import { prisma } from "../src/lib/prisma.js";
import { complianceOf } from "../src/services/compliance.service.js";
import {
  reinstateCredential,
  revokeCredential,
  setAdmittedJurisdictions,
  suspendCredential,
} from "../src/services/issuer.service.js";
import { resetVerificationKeyCache, verificationStanding, verifyProof } from "../src/services/proof-verification.service.js";
import { reconcileCredentialTree } from "../src/services/tree.service.js";
import { resetDatabase } from "./helpers/database.js";
import { holderWallet, issueCredentialForHolder } from "./helpers/holder.js";
import {
  invalidateCredentialRoot,
  isCredentialRootValid,
  publishCountryRoot,
  publishCredentialRoot,
  resetRegistryStub,
  state,
} from "./helpers/registry-stub.js";

/// A public endpoint behind a load balancer answers `latest` from whichever backend
/// it reaches, and that backend can be a block or two behind the one that mined the
/// transaction this service just waited for. These tests make the stub lag the same
/// way and check that nothing the service decides rests on such a read.

function verificationFor(subject: string, countryCode: number) {
  return {
    kycSubjectId: subject,
    holderAddress: holderWallet(subject).address,
    approved: true,
    countryCode,
    expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    verificationRef: "VF-2026-000117",
    identity: { legalName: `Holder ${subject}`, documentType: "CC", documentNumber: `DOC-${subject}`, countryCode },
  };
}

beforeEach(async () => {
  await resetDatabase();
  resetRegistryStub();
});

describe("revoking against a lagging node", () => {
  it("closes the window of the root the publication actually replaced", async () => {
    const first = await issueCredentialForHolder(verificationFor("subject-a", 170));
    const second = await issueCredentialForHolder(verificationFor("subject-b", 724));
    state.headLag = 1n;

    const revocation = await revokeCredential(second.commitment);

    expect(revocation.previousRoot).toBe(second.credentialRoot);
    expect(revocation.previousRootInvalidated).toBe(true);
    expect(await isCredentialRootValid(BigInt(second.credentialRoot), { at: state.blockNumber })).toBe(false);
    expect(state.credentialRoot.toString()).toBe(first.credentialRoot);
  });

  it("records each publication's predecessor as the root before it, however far latest lags", async () => {
    state.headLag = 3n;
    await issueCredentialForHolder(verificationFor("subject-a", 170));
    const bob = await issueCredentialForHolder(verificationFor("subject-b", 724));
    await issueCredentialForHolder(verificationFor("subject-c", 250));
    await suspendCredential(bob.commitment);
    await reinstateCredential(bob.commitment);
    await revokeCredential(bob.commitment, false);

    const rows = await prisma.rootPublication.findMany({ where: { kind: "CREDENTIAL" }, orderBy: { blockNumber: "asc" } });
    expect(rows).toHaveLength(6);
    expect(rows[0]!.previousRoot).toBe("0");
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.previousRoot).toBe(rows[i - 1]!.root);
  });

  it("surfaces the registry's refusal to drop the current root as a decoded revert", async () => {
    await issueCredentialForHolder(verificationFor("subject-a", 170));
    await expect(invalidateCredentialRoot(state.credentialRoot)).rejects.toMatchObject({
      output: { statusCode: 424, payload: { code: "root_invalidation_reverted", details: { revert: { error: "RootIsCurrent" } } } },
    });
    await expect(invalidateCredentialRoot(12345n)).rejects.toMatchObject({
      output: { payload: { code: "root_invalidation_reverted", details: { revert: { error: "UnknownRoot" } } } },
    });
  });

  it("reports a root the registry already holds as a decoded RootUnchanged", async () => {
    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));
    await expect(publishCredentialRoot(BigInt(issued.credentialRoot), [])).rejects.toMatchObject({
      output: { payload: { code: "root_publication_reverted", details: { revert: { error: "RootUnchanged" } } } },
    });
  });
});

describe("jurisdictions against a lagging node", () => {
  it("compares a new set with the set it knows it published, not with a stale root", async () => {
    await setAdmittedJurisdictions("42", [724, 250]);
    state.headLag = 1n;
    const changed = await setAdmittedJurisdictions("42", [724, 840]);

    expect(state.countryRoots.get("42")?.toString()).toBe(changed.countryRoot);
    await expect(setAdmittedJurisdictions("42", [840, 724])).rejects.toMatchObject({
      output: { statusCode: 409, payload: { code: "jurisdiction_set_unchanged" } },
    });
  });
});

describe("answers read at one block", () => {
  let fixture: { meta: { currentEpochEnd: string; assetA: string }; roots: { credentialCurrent: string; countryA: string }; proofs: Record<string, Groth16CallData> };

  beforeAll(async () => {
    fixture = JSON.parse(await readFile(resolve(import.meta.dirname, "fixtures/compliance-proofs.json"), "utf8"));
  });

  beforeEach(async () => {
    resetVerificationKeyCache();
    state.currentEpochEnd = BigInt(fixture.meta.currentEpochEnd);
    await publishCredentialRoot(BigInt(fixture.roots.credentialCurrent), []);
    await publishCountryRoot(BigInt(fixture.meta.assetA), BigInt(fixture.roots.countryA), []);
    state.headLag = 2n;
    state.readBlocks = [];
  });

  it("verifies a proof against roots published a moment ago", async () => {
    const outcome = await verifyProof(fixture.proofs.aliceCurrent!);

    expect(outcome.rejectionCode).toBeNull();
    expect(outcome.valid).toBe(true);
    expect(state.readBlocks.length).toBeGreaterThan(0);
    expect(new Set(state.readBlocks)).toEqual(new Set([state.blockNumber]));
  });

  it("answers the standing of a verdict from the same fresh state", async () => {
    const outcome = await verifyProof(fixture.proofs.aliceCurrent!);
    const standing = await verificationStanding(outcome.id);
    expect(standing.credentialRootStillValid).toBe(true);
    expect(standing.standing).toBe("live");
  });

  it("does not call a just-registered asset unregistered", async () => {
    const answer = await complianceOf(fixture.meta.assetA, holderWallet("subject-a").address);
    expect(answer.compliant).toBe(false);
    expect(state.readBlocks.every((block) => block === state.blockNumber)).toBe(true);
  });

  it("reconciles against the root at the block it replayed through", async () => {
    const report = await reconcileCredentialTree();
    expect(report.throughBlock).toBe(state.blockNumber.toString());
    expect(report.onChainRoot).toBe(fixture.roots.credentialCurrent);
  });
});
