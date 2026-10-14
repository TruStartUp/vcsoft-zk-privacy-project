import type { Express } from "express";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/registry.service.js", () => import("./helpers/registry-stub.js"));

import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createPartner, type CreatedPartner } from "../src/services/partner.service.js";
import { reconcileIssuerState } from "../src/services/tree.service.js";
import { resetDatabase } from "./helpers/database.js";
import { activationSignature, holderSecretOf, holderWallet } from "./helpers/holder.js";
import {
  invalidateCredentialRoot,
  isCountryRootValid,
  isCredentialRootValid,
  resetRegistryStub,
  state,
} from "./helpers/registry-stub.js";
import { signedRequest } from "./helpers/signed-request.js";

/// What happens when the chain and the database stop agreeing halfway through a change:
/// a publication that went through while the step after it failed, and a publication
/// whose receipt never arrived although it was mined. Every case is driven through the
/// routes, because that is where the operator meets it.

const ASSET = "42";

let server: Express;
let desk: CreatedPartner;
let platform: CreatedPartner;
let operator: CreatedPartner;

beforeAll(() => {
  server = createApp();
});

beforeEach(async () => {
  await resetDatabase();
  resetRegistryStub();
  desk = await createPartner("issuing-desk", ["credentials:issue", "credentials:revoke", "credentials:read", "jurisdictions:write"]);
  platform = await createPartner("holder-platform", ["credentials:activate"]);
  operator = await createPartner("operator", ["issuer:admin"]);
});

function as(partner: CreatedPartner, method: "get" | "post" | "put" | "delete", path: string, body?: unknown) {
  return signedRequest(server, { method, path, partnerKey: partner.partnerKey, secret: partner.secret, body });
}

async function register(subject: string) {
  const wallet = holderWallet(subject);
  const response = await as(desk, "post", "/v1/credentials", {
    kycSubjectId: subject,
    holderAddress: wallet.address,
    verification: {
      approved: true,
      countryCode: 170,
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      reference: `VF-${subject}`,
    },
    identity: { legalName: `Holder ${subject}`, documentType: "CC", documentNumber: subject, countryCode: 170 },
  });
  expect(response.status).toBe(201);
  const { secretHash } = await holderSecretOf(wallet);
  const activation = {
    secretHash: secretHash.toString(),
    signature: await activationSignature(wallet, response.body.credentialId, secretHash),
  };
  return { credentialId: response.body.credentialId as string, activation };
}

function activate(pending: { credentialId: string; activation: unknown }) {
  return as(platform, "post", `/v1/credentials/${pending.credentialId}/activation`, pending.activation);
}

async function issue(subject: string) {
  const response = await activate(await register(subject));
  expect(response.status).toBe(201);
  return response.body as { commitment: string; credentialRoot: string; txHash: string };
}

async function reconcile() {
  const response = await as(operator, "post", "/v1/issuer/state/rebuild");
  expect(response.status).toBe(200);
  return response.body as {
    matchesChain: boolean;
    missingFromDatabase: string[];
    missingFromChain: string[];
    pendingRootInvalidations: string[];
  };
}

describe("a removal whose window closure fails after the publication went through", () => {
  it("keeps the revocation, reports the closure pending, and closes it when the request is repeated", async () => {
    await issue("subject-a");
    const bob = await issue("subject-b");

    state.failingInvalidations = 1;
    const first = await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`);

    expect(first.status).toBe(424);
    expect(first.body.code).toBe("root_invalidation_pending");
    expect(first.body.details).toMatchObject({
      commitment: bob.commitment,
      status: "REVOKED",
      previousRoot: bob.credentialRoot,
      previousRootInvalidated: false,
      cause: { code: "chain_call_failed" },
    });

    const stored = await prisma.credential.findUniqueOrThrow({ where: { commitment: bob.commitment } });
    expect(stored).toMatchObject({ status: "REVOKED", inTree: false });
    expect(state.credentialRoot.toString()).toBe(first.body.details.credentialRoot);
    expect(await isCredentialRootValid(BigInt(bob.credentialRoot))).toBe(true);

    const pending = await reconcile();
    expect(pending).toMatchObject({ matchesChain: true, missingFromDatabase: [], missingFromChain: [] });
    expect(pending.pendingRootInvalidations).toEqual([bob.commitment]);

    const retry = await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      commitment: bob.commitment,
      status: "REVOKED",
      txHash: first.body.details.txHash,
      previousRootInvalidated: true,
    });
    expect(await isCredentialRootValid(BigInt(bob.credentialRoot))).toBe(false);
    expect((await reconcile()).pendingRootInvalidations).toEqual([]);

    const again = await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("credential_not_in_tree");
  });

  it("does the same for a suspension", async () => {
    await issue("subject-a");
    const bob = await issue("subject-b");

    state.failingInvalidations = 1;
    const first = await as(desk, "post", `/v1/credentials/${bob.commitment}/suspension`, {});
    expect(first.status).toBe(424);
    expect(first.body.details).toMatchObject({ status: "SUSPENDED", previousRootInvalidated: false });

    const retry = await as(desk, "post", `/v1/credentials/${bob.commitment}/suspension`, {});
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ status: "SUSPENDED", previousRootInvalidated: true });
    expect(await isCredentialRootValid(BigInt(bob.credentialRoot))).toBe(false);
  });

  /// The failed attempt may have been mined after all. The retry finds the root already
  /// closed and records it, without sending anything.
  it("recognises a closure that reached the chain although its caller was told it failed", async () => {
    await issue("subject-a");
    const bob = await issue("subject-b");

    state.failingInvalidations = 1;
    const first = await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`, {});
    expect(first.status).toBe(424);
    await invalidateCredentialRoot(BigInt(bob.credentialRoot));
    const blockBefore = state.blockNumber;

    const retry = await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`, {});
    expect(retry.status).toBe(200);
    expect(retry.body.previousRootInvalidated).toBe(true);
    expect(state.blockNumber).toBe(blockBefore);

    const publication = await prisma.rootPublication.findFirstOrThrow({ where: { commitment: bob.commitment, root: first.body.details.credentialRoot } });
    expect(publication.invalidatedAt).not.toBeNull();
    expect(publication.invalidationTxHash).toBeNull();
  });

  it("leaves a pending closure alone when the repeated request asks to keep the window open", async () => {
    await issue("subject-a");
    const bob = await issue("subject-b");

    state.failingInvalidations = 1;
    expect((await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`)).status).toBe(424);

    const retry = await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`, { closeRootWindow: false });
    expect(retry.status).toBe(409);
    expect((await reconcile()).pendingRootInvalidations).toEqual([bob.commitment]);
  });

  it("drops a pending closure once the suspended leaf is reinstated", async () => {
    await issue("subject-a");
    const bob = await issue("subject-b");

    state.failingInvalidations = 1;
    expect((await as(desk, "post", `/v1/credentials/${bob.commitment}/suspension`)).status).toBe(424);

    const reinstated = await as(desk, "delete", `/v1/credentials/${bob.commitment}/suspension`);
    expect(reinstated.status).toBe(200);
    expect(reinstated.body.credentialRoot).toBe(bob.credentialRoot);
    expect((await reconcile()).pendingRootInvalidations).toEqual([]);
  });
});

describe("a publication mined after its receipt timed out", () => {
  it("adopts the activation on the retry instead of failing with RootUnchanged", async () => {
    await issue("subject-a");
    const pending = await register("subject-b");

    state.timeoutNextPublication = true;
    const first = await activate(pending);
    expect(first.status).toBe(424);
    expect(first.body.code).toBe("chain_receipt_timeout");
    const minedTx = first.body.details.txHash as string;

    expect(await prisma.credential.findUniqueOrThrow({ where: { id: pending.credentialId } })).toMatchObject({
      status: "PENDING",
      commitment: null,
    });
    const diverged = await reconcile();
    expect(diverged.missingFromDatabase).toHaveLength(1);

    const retry = await activate(pending);
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ status: "ACTIVE", txHash: minedTx });
    expect(retry.body.credentialRoot).toBe(state.credentialRoot.toString());
    expect(await prisma.rootPublication.count({ where: { txHash: minedTx } })).toBe(1);

    expect(await reconcile()).toMatchObject({
      matchesChain: true,
      missingFromDatabase: [],
      missingFromChain: [],
      pendingRootInvalidations: [],
    });
  });

  it("adopts the revocation on the retry and still closes the window", async () => {
    await issue("subject-a");
    const bob = await issue("subject-b");

    state.timeoutNextPublication = true;
    const first = await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`, {});
    expect(first.status).toBe(424);
    expect(first.body.code).toBe("chain_receipt_timeout");
    expect((await reconcile()).missingFromChain).toEqual([bob.commitment]);

    const retry = await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`, {});
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      status: "REVOKED",
      txHash: first.body.details.txHash,
      previousRoot: bob.credentialRoot,
      previousRootInvalidated: true,
    });
    expect(await isCredentialRootValid(BigInt(bob.credentialRoot))).toBe(false);
    expect(await reconcile()).toMatchObject({ missingFromDatabase: [], missingFromChain: [], pendingRootInvalidations: [] });
  });

  it("still refuses a root that is current for reasons of its own", async () => {
    const alice = await issue("subject-a");
    await prisma.credential.update({ where: { commitment: alice.commitment }, data: { inTree: false, status: "SUSPENDED" } });

    const reinstated = await as(desk, "delete", `/v1/credentials/${alice.commitment}/suspension`);
    expect(reinstated.status).toBe(424);
    expect(reinstated.body).toMatchObject({ code: "root_publication_reverted", details: { revert: { error: "RootUnchanged" } } });
  });

  it("adopts a jurisdiction change on the retry", async () => {
    expect((await as(desk, "put", `/v1/assets/${ASSET}/jurisdictions`, { admitted: [170] })).status).toBe(200);

    state.timeoutNextPublication = true;
    const first = await as(desk, "put", `/v1/assets/${ASSET}/jurisdictions`, { admitted: [170, 724] });
    expect(first.status).toBe(424);
    expect(first.body.code).toBe("chain_receipt_timeout");

    const retry = await as(desk, "put", `/v1/assets/${ASSET}/jurisdictions`, { admitted: [170, 724] });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ txHash: first.body.details.txHash, previousRootInvalidated: false });
    expect(retry.body.countryRoot).toBe(state.countryRoots.get(ASSET)?.toString());
  });
});

describe("withdrawing a jurisdiction", () => {
  async function admit(admitted: number[], extra: Record<string, unknown> = {}) {
    return as(desk, "put", `/v1/assets/${ASSET}/jurisdictions`, { admitted, ...extra });
  }

  it("closes the superseded country root's window by default", async () => {
    const before = await admit([170, 724]);
    const withdrawn = await admit([170]);

    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.previousRootInvalidated).toBe(true);
    expect(await isCountryRootValid(BigInt(ASSET), BigInt(before.body.countryRoot))).toBe(false);
    expect(await isCountryRootValid(BigInt(ASSET), BigInt(withdrawn.body.countryRoot))).toBe(true);
  });

  it("closes nothing when the change only adds countries", async () => {
    const before = await admit([170]);
    const added = await admit([170, 724]);

    expect(added.body.previousRootInvalidated).toBe(false);
    expect(await isCountryRootValid(BigInt(ASSET), BigInt(before.body.countryRoot))).toBe(true);
  });

  it("leaves the window open when asked to", async () => {
    const before = await admit([170, 724]);
    const withdrawn = await admit([170], { closeRootWindow: false });

    expect(withdrawn.body.previousRootInvalidated).toBe(false);
    expect(await isCountryRootValid(BigInt(ASSET), BigInt(before.body.countryRoot))).toBe(true);
  });

  it("keeps the change when the closure fails and closes it when the same set is sent again", async () => {
    const before = await admit([170, 724]);

    state.failingInvalidations = 1;
    const first = await admit([170]);
    expect(first.status).toBe(424);
    expect(first.body).toMatchObject({ code: "root_invalidation_pending", details: { admitted: [170], previousRootInvalidated: false } });
    expect(await isCountryRootValid(BigInt(ASSET), BigInt(before.body.countryRoot))).toBe(true);

    const report = await as(operator, "post", `/v1/issuer/assets/${ASSET}/state/rebuild`);
    expect(report.body).toMatchObject({ matchesChain: true, missingFromDatabase: [], missingFromChain: [] });
    expect(report.body.pendingRootInvalidations).toEqual([before.body.countryRoot]);

    const retry = await admit([170]);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ txHash: first.body.details.txHash, previousRootInvalidated: true });
    expect(await isCountryRootValid(BigInt(ASSET), BigInt(before.body.countryRoot))).toBe(false);

    const unchanged = await admit([170]);
    expect(unchanged.status).toBe(409);
    expect(unchanged.body.code).toBe("jurisdiction_set_unchanged");
  });
});

describe("reconciling the whole issuer state", () => {
  it("finds nothing to report on a healthy state", async () => {
    await issue("subject-a");
    await as(desk, "put", `/v1/assets/${ASSET}/jurisdictions`, { admitted: [170, 724] });

    const result = await reconcileIssuerState([ASSET]);
    expect(result.problems).toEqual([]);
  });

  it("names a commitment the database holds and the chain does not", async () => {
    await issue("subject-a");
    await prisma.credential.create({
      data: {
        commitment: "999999999999999999",
        subjectRef: "ff".repeat(32),
        holderAddress: holderWallet("ghost").address.toLowerCase(),
        leafIndex: 7,
        countryCode: 170,
        expiresAt: new Date(Date.now() + 86_400_000),
        status: "ACTIVE",
        inTree: true,
        verificationRef: "VF-ghost",
      },
    });

    const result = await reconcileIssuerState([]);
    expect(result.credentialTree.matchesChain).toBe(true);
    expect(result.problems).toEqual(["credentialTree: 1 in the database and missing from the chain"]);
  });

  it("names a jurisdiction tree that disagrees with the database even when the chain agrees with itself", async () => {
    await as(desk, "put", `/v1/assets/${ASSET}/jurisdictions`, { admitted: [170, 724] });
    await prisma.jurisdictionLeaf.updateMany({ where: { assetId: ASSET, countryCode: 724 }, data: { admitted: false } });

    const result = await reconcileIssuerState([ASSET]);
    const jurisdictionTree = result.jurisdictionTrees[0]?.jurisdictionTree;
    expect(jurisdictionTree).toMatchObject({ matchesChain: true, missingFromDatabase: [724], missingFromChain: [] });
    expect(result.problems).toEqual([`jurisdictionTree ${ASSET}: 1 on chain and missing from the database`]);
  });

  it("names a window closure left pending", async () => {
    await issue("subject-a");
    const bob = await issue("subject-b");
    state.failingInvalidations = 1;
    await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`);

    const result = await reconcileIssuerState([]);
    expect(result.problems).toEqual(["credentialTree: 1 superseded root window(s) still to close"]);
  });

  it("names a replay that does not reach the on-chain root", async () => {
    await issue("subject-a");
    state.credentialEvents.length = 0;

    const result = await reconcileIssuerState([]);
    expect(result.problems).toContain("credentialTree: the replayed root does not match the on-chain root");
  });
});
