import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { Express } from "express";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/registry.service.js", () => import("./helpers/registry-stub.js"));

import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { sealIdentity, toEnvelopeColumns } from "../src/services/disclosure.service.js";
import { createPartner, rotatePartnerSecret, setPartnerStatus, type CreatedPartner } from "../src/services/partner.service.js";
import { resetDatabase } from "./helpers/database.js";
import { activationSignature, holderSecretOf, holderWallet } from "./helpers/holder.js";
import { isCredentialRootValid, resetRegistryStub, state } from "./helpers/registry-stub.js";
import { signedRequest } from "./helpers/signed-request.js";

/// What an operator does by hand, through the routes and scripts it would use.

const ACTIVE_KEY = "vk-2026-09";
const SUPERSEDED_KEY = "vk-2026-03";
const API_ROOT = resolve(import.meta.dirname, "..");
const run = promisify(execFile);

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

function verdict(subject: string) {
  return {
    kycSubjectId: subject,
    holderAddress: holderWallet(subject).address,
    verification: {
      approved: true,
      countryCode: 170,
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      reference: `VF-${subject}`,
    },
    identity: { legalName: `Holder ${subject}`, documentType: "CC", documentNumber: subject, countryCode: 170 },
  };
}

async function issue(subject: string) {
  const registered = await as(desk, "post", "/v1/credentials", verdict(subject));
  expect(registered.status).toBe(201);
  const wallet = holderWallet(subject);
  const { secretHash } = await holderSecretOf(wallet);
  const activated = await as(platform, "post", `/v1/credentials/${registered.body.credentialId}/activation`, {
    secretHash: secretHash.toString(),
    signature: await activationSignature(wallet, registered.body.credentialId, secretHash),
  });
  expect(activated.status).toBe(201);
  return activated.body as { commitment: string; credentialRoot: string };
}

describe("routes whose body is optional", () => {
  it("revokes with the defaults when no body is sent", async () => {
    await issue("subject-a");
    const bob = await issue("subject-b");

    const response = await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "REVOKED", previousRootInvalidated: true });
    expect(await isCredentialRootValid(BigInt(bob.credentialRoot))).toBe(false);
  });

  it("suspends with the defaults when no body is sent", async () => {
    await issue("subject-a");
    const bob = await issue("subject-b");

    const response = await as(desk, "post", `/v1/credentials/${bob.commitment}/suspension`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "SUSPENDED", previousRootInvalidated: true });
  });

  it("rotates viewing keys with the defaults when no body is sent", async () => {
    await issue("subject-a");

    const response = await as(operator, "post", "/v1/disclosures/viewing-keys/rotation");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ rotated: 0, alreadyCurrent: 1, failed: [], remaining: 0 });
  });

  it("names the missing fields of a route whose body is required, instead of failing inside", async () => {
    const registration = await as(desk, "post", "/v1/credentials");
    expect(registration.status).toBe(400);
    expect(registration.body.code).toBe("validation_failed");

    const jurisdictions = await as(desk, "put", "/v1/assets/42/jurisdictions");
    expect(jurisdictions.status).toBe(400);
    expect(jurisdictions.body.code).toBe("validation_failed");
  });
});

describe("retiring a suspended credential", () => {
  it("revokes a suspended credential that has expired and frees its subject", async () => {
    await issue("subject-a");
    const bob = await issue("subject-b");
    expect((await as(desk, "post", `/v1/credentials/${bob.commitment}/suspension`)).status).toBe(200);
    await prisma.credential.update({ where: { commitment: bob.commitment }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const reinstated = await as(desk, "delete", `/v1/credentials/${bob.commitment}/suspension`);
    expect(reinstated.status).toBe(409);
    expect(reinstated.body.code).toBe("credential_expired");

    const blocked = await as(desk, "post", "/v1/credentials", verdict("subject-b"));
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("credential_already_issued");

    const rootBefore = state.credentialRoot;
    const blockBefore = state.blockNumber;
    const revoked = await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`);

    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ commitment: bob.commitment, status: "REVOKED", previousRootInvalidated: true });
    expect(state.credentialRoot).toBe(rootBefore);
    expect(state.blockNumber).toBe(blockBefore);

    const standing = await as(desk, "get", `/v1/credentials/${bob.commitment}`);
    expect(standing.body).toMatchObject({ status: "REVOKED", inRegistry: false });

    const reissued = await as(desk, "post", "/v1/credentials", verdict("subject-b"));
    expect(reissued.status).toBe(201);
  });

  /// Reinstating first and revoking afterwards would put the leaf back on chain for the
  /// length of two publications; retiring it directly never does.
  it("never puts the leaf back on chain while retiring it", async () => {
    await issue("subject-a");
    const bob = await issue("subject-b");
    await as(desk, "post", `/v1/credentials/${bob.commitment}/suspension`);
    const eventsBefore = state.credentialEvents.length;

    expect((await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`)).status).toBe(200);

    expect(state.credentialEvents.length).toBe(eventsBefore);
    const again = await as(desk, "post", `/v1/credentials/${bob.commitment}/revocation`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("credential_not_in_tree");
  });

  it("still refuses to suspend a credential that is already suspended", async () => {
    const alice = await issue("subject-a");
    await as(desk, "post", `/v1/credentials/${alice.commitment}/suspension`);

    const response = await as(desk, "post", `/v1/credentials/${alice.commitment}/suspension`);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("credential_not_in_tree");
  });
});

describe("suspending a partner and rotating its secret", () => {
  const read = (partner: CreatedPartner, secret = partner.secret) =>
    signedRequest(server, { method: "post", path: "/v1/issuer/state/rebuild", partnerKey: partner.partnerKey, secret });

  it("refuses a suspended partner and serves it again once reactivated", async () => {
    await setPartnerStatus(operator.partnerKey, "SUSPENDED");
    const refused = await read(operator);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("partner_suspended");

    await setPartnerStatus(operator.partnerKey, "ACTIVE");
    expect((await read(operator)).status).toBe(200);
  });

  it("stops verifying the old secret the moment a new one is issued", async () => {
    const rotated = await rotatePartnerSecret(operator.partnerKey);
    expect(rotated.secret).not.toBe(operator.secret);
    expect(rotated.partnerKey).toBe(operator.partnerKey);

    const old = await read(operator);
    expect(old.status).toBe(401);
    expect(old.body.code).toBe("invalid_signature");
    expect((await read(operator, rotated.secret)).status).toBe(200);
  });

  /// The script is what an operator runs, so it is run here as a process, against the
  /// suite's own database and nothing else.
  it("does both from the command line", async () => {
    const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL };
    const cli = (...args: string[]) =>
      run("npx", ["tsx", "scripts/manage-partner.ts", ...args], { cwd: API_ROOT, env }).then(
        (done) => ({ code: 0, stdout: done.stdout, stderr: done.stderr }),
        (failed: { code: number; stdout: string; stderr: string }) => failed,
      );

    const suspended = await cli("suspend", operator.partnerKey);
    expect(suspended.code).toBe(0);
    expect(JSON.parse(suspended.stdout)).toMatchObject({ partnerKey: operator.partnerKey, status: "SUSPENDED" });
    expect((await read(operator)).body.code).toBe("partner_suspended");

    expect((await cli("reactivate", operator.partnerKey)).code).toBe(0);
    const rotation = await cli("rotate-secret", operator.partnerKey);
    expect(rotation.code).toBe(0);
    const { secret } = JSON.parse(rotation.stdout.slice(0, rotation.stdout.lastIndexOf("}") + 1)) as { secret: string };
    expect((await read(operator)).status).toBe(401);
    expect((await read(operator, secret)).status).toBe(200);

    const listed = await cli("list");
    expect(JSON.parse(listed.stdout).map((row: { partnerKey: string }) => row.partnerKey)).toContain(operator.partnerKey);
    expect(listed.stdout).not.toContain(secret);

    const unknown = await cli("suspend", "pk_000000000000000000000000");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("no partner holds the key");
    expect((await cli("freeze", operator.partnerKey)).code).toBe(2);
  }, 60_000);
});

describe("rotating viewing keys past envelopes that cannot be opened", () => {
  let sequence = 0;

  /// Unreadable envelopes get the lowest identifiers and are written first, so they come first
  /// in any order a page of envelopes could be read in.
  async function envelopeUnder(subject: string, viewingKeyId: string, retiredAs?: string) {
    sequence += 1;
    const id = `${retiredAs ? "00000000" : "ffffffff"}-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
    const credential = await prisma.credential.create({
      data: {
        subjectRef: subject.padEnd(64, "0"),
        holderAddress: holderWallet(subject).address.toLowerCase(),
        countryCode: 170,
        expiresAt: new Date(Date.now() + 86_400_000),
        status: "PENDING",
        verificationRef: `VF-${subject}`,
      },
    });
    const sealed = toEnvelopeColumns(sealIdentity({ legalName: subject, documentType: "CC", documentNumber: subject, countryCode: 170 }, credential.id, viewingKeyId));
    await prisma.identityEnvelope.create({
      data: { id, credentialId: credential.id, ...sealed, viewingKeyId: retiredAs ?? sealed.viewingKeyId },
    });
    return credential.id;
  }

  /// With as many unopenable envelopes as the batch holds, a rotation that only ever
  /// looks at the first batch moves nothing, call after call, and the envelopes behind
  /// them stay on the old key while the answer reads like the end of the job.
  it("moves every envelope it can open, and says how many are left", async () => {
    const unopenable = [];
    for (const subject of ["a1", "a2", "a3"]) unopenable.push(await envelopeUnder(subject, SUPERSEDED_KEY, "vk-0000-retired"));
    for (const subject of ["b1", "b2"]) await envelopeUnder(subject, SUPERSEDED_KEY);

    const first = await as(operator, "post", "/v1/disclosures/viewing-keys/rotation", { batchSize: 3 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ rotated: 2, remaining: 3 });
    expect([...first.body.failed].sort()).toEqual([...unopenable].sort());

    const second = await as(operator, "post", "/v1/disclosures/viewing-keys/rotation", { batchSize: 3 });
    expect(second.body).toMatchObject({ rotated: 0, alreadyCurrent: 2, remaining: 3 });
    expect(second.body.failed).toHaveLength(3);

    expect(await prisma.identityEnvelope.count({ where: { viewingKeyId: SUPERSEDED_KEY } })).toBe(0);
    expect(await prisma.identityEnvelope.count({ where: { viewingKeyId: ACTIVE_KEY } })).toBe(2);
  });

  it("stops at the batch size when everything can be opened", async () => {
    for (const subject of ["c1", "c2", "c3", "c4", "c5"]) await envelopeUnder(subject, SUPERSEDED_KEY);

    const first = await as(operator, "post", "/v1/disclosures/viewing-keys/rotation", { batchSize: 2 });
    expect(first.body).toMatchObject({ rotated: 2, failed: [], remaining: 3 });
    const second = await as(operator, "post", "/v1/disclosures/viewing-keys/rotation", { batchSize: 2 });
    expect(second.body).toMatchObject({ rotated: 2, remaining: 1 });
    const third = await as(operator, "post", "/v1/disclosures/viewing-keys/rotation", { batchSize: 2 });
    expect(third.body).toMatchObject({ rotated: 1, remaining: 0 });
  });
});
