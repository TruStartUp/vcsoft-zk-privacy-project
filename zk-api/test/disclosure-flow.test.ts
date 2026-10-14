import type { Express } from "express";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/registry.service.js", () => import("./helpers/registry-stub.js"));

import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { flushAccessLog } from "../src/middleware/access-log.js";
import { verifyAccessLogIntegrity } from "../src/services/access-log.service.js";
import { requestDigestOf } from "../src/services/disclosure.service.js";
import { holderWallet, issueCredentialForHolder } from "./helpers/holder.js";
import { createPartner, type Scope } from "../src/services/partner.service.js";
import { resetDatabase } from "./helpers/database.js";
import { resetRegistryStub } from "./helpers/registry-stub.js";
import { signedRequest } from "./helpers/signed-request.js";

const JUSTIFICATION =
  "Requerimiento 2026-0311 de la Superintendencia Financiera sobre la operacion del activo 42";

let app: Express;
let commitment: string;
let regulator: { partnerKey: string; secret: string };
let compliance: { partnerKey: string; secret: string };

async function partner(name: string, scopes: Scope[]) {
  return createPartner(name, scopes);
}

async function openRequest(scope: string[] = ["identity.legalName", "identity.documentNumber"]) {
  const response = await signedRequest(app, {
    method: "post",
    path: "/v1/disclosures",
    partnerKey: regulator.partnerKey,
    secret: regulator.secret,
    actorRef: "supervisor-19",
    body: {
      targetCommitment: commitment,
      requesterRef: "SFC-2026-0311",
      justification: JUSTIFICATION,
      legalBasis: "Estatuto Organico del Sistema Financiero, art. 326",
      scope,
    },
  });
  return response;
}

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  await resetDatabase();
  resetRegistryStub();

  regulator = await partner("regulator", ["disclosures:request", "disclosures:read"]);
  compliance = await partner("compliance-office", ["disclosures:approve", "disclosures:read"]);

  const issued = await issueCredentialForHolder({
    kycSubjectId: "subject-disclosure",
    holderAddress: holderWallet("subject-disclosure").address,
    approved: true,
    countryCode: 170,
    expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    verificationRef: "VF-2026-000117",
    identity: {
      legalName: "Ana María Restrepo Gil",
      documentType: "CC",
      documentNumber: "1020304050",
      countryCode: 170,
      residenceAddress: "Carrera 43A 1-50, Medellín",
    },
  });
  commitment = issued.commitment;
});

describe("requesting a disclosure", () => {
  it("records who asked, on whose behalf, why and over what", async () => {
    const response = await openRequest();

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: "PENDING",
      requesterRef: "SFC-2026-0311",
      justification: JUSTIFICATION,
      targetCommitment: commitment,
      scope: ["identity.legalName", "identity.documentNumber"],
    });
    expect(response.body.requestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  /// HMAC gives non-repudiation against a party who does not hold the verifier's
  /// copy of the key. Keeping the signature next to the digest is what lets an
  /// auditor re-derive that the partner, and nobody else with their key, signed
  /// exactly these bytes.
  it("keeps the partner's own signature over the request beside it", async () => {
    const response = await openRequest();
    const stored = await prisma.disclosureRequest.findUniqueOrThrow({ where: { id: response.body.id } });

    expect(stored.requestSignature).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.requestDigest).toBe(
      requestDigestOf({
        partnerId: stored.partnerId,
        requesterRef: stored.requesterRef,
        justification: stored.justification,
        legalBasis: stored.legalBasis,
        scope: stored.scope,
        targetCommitment: stored.targetCommitment,
        requestSignature: stored.requestSignature,
      }),
    );
  });

  it("refuses a request over a commitment nobody holds", async () => {
    const response = await signedRequest(app, {
      method: "post",
      path: "/v1/disclosures",
      partnerKey: regulator.partnerKey,
      secret: regulator.secret,
      body: {
        targetCommitment: "12345678901234567890",
        requesterRef: "SFC-2026-0311",
        justification: JUSTIFICATION,
        legalBasis: "art. 326",
        scope: ["identity.legalName"],
      },
    });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("credential_not_found");
  });

  it("refuses a request with no real justification", async () => {
    const response = await signedRequest(app, {
      method: "post",
      path: "/v1/disclosures",
      partnerKey: regulator.partnerKey,
      secret: regulator.secret,
      body: {
        targetCommitment: commitment,
        requesterRef: "SFC-2026-0311",
        justification: "porque si",
        legalBasis: "art. 326",
        scope: ["identity.legalName"],
      },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("validation_failed");
  });

  it("refuses a scope that is not a disclosable attribute", async () => {
    const response = await openRequest(["identity.legalName", "credential.secret"]);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("validation_failed");
  });
});

describe("deciding and releasing", () => {
  it("releases only the attributes the approval names", async () => {
    const request = await openRequest(["identity.legalName"]);

    const decision = await signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${request.body.id}/decision`,
      partnerKey: compliance.partnerKey,
      secret: compliance.secret,
      body: { decision: "APPROVED", decidedBy: "compliance-officer-3" },
    });
    expect(decision.status).toBe(200);
    expect(decision.body.status).toBe("APPROVED");

    const release = await signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${request.body.id}/release`,
      partnerKey: regulator.partnerKey,
      secret: regulator.secret,
      body: {},
    });

    expect(release.status).toBe(200);
    expect(release.body.released).toEqual({ legalName: "Ana María Restrepo Gil" });
    expect(JSON.stringify(release.body)).not.toContain("1020304050");
    expect(JSON.stringify(release.body)).not.toContain("Medellín");
  });

  it("releases nothing while the request is still pending", async () => {
    const request = await openRequest();

    const release = await signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${request.body.id}/release`,
      partnerKey: regulator.partnerKey,
      secret: regulator.secret,
      body: {},
    });

    expect(release.status).toBe(403);
    expect(release.body.code).toBe("disclosure_not_approved");
  });

  it("releases nothing on a denied request", async () => {
    const request = await openRequest();

    await signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${request.body.id}/decision`,
      partnerKey: compliance.partnerKey,
      secret: compliance.secret,
      body: { decision: "DENIED", decidedBy: "compliance-officer-3", note: "alcance excesivo" },
    });

    const release = await signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${request.body.id}/release`,
      partnerKey: regulator.partnerKey,
      secret: regulator.secret,
      body: {},
    });

    expect(release.status).toBe(403);
    expect(release.body.code).toBe("disclosure_not_approved");
  });

  it("refuses to decide the same request twice", async () => {
    const request = await openRequest();
    const decide = (decision: string) =>
      signedRequest(app, {
        method: "post",
        path: `/v1/disclosures/${request.body.id}/decision`,
        partnerKey: compliance.partnerKey,
        secret: compliance.secret,
        body: { decision, decidedBy: "compliance-officer-3" },
      });

    expect((await decide("APPROVED")).status).toBe(200);
    const second = await decide("DENIED");
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("disclosure_request_already_decided");
  });

  it("cannot be approved by the partner that asked for it", async () => {
    const request = await openRequest();
    const response = await signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${request.body.id}/decision`,
      partnerKey: regulator.partnerKey,
      secret: regulator.secret,
      body: { decision: "APPROVED", decidedBy: "supervisor-19" },
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("insufficient_scope");
  });

  it("releases the whole approved scope when it names several attributes", async () => {
    const request = await openRequest([
      "identity.legalName",
      "identity.documentNumber",
      "identity.residenceAddress",
    ]);

    await signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${request.body.id}/decision`,
      partnerKey: compliance.partnerKey,
      secret: compliance.secret,
      body: { decision: "APPROVED", decidedBy: "compliance-officer-3" },
    });

    const release = await signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${request.body.id}/release`,
      partnerKey: regulator.partnerKey,
      secret: regulator.secret,
      body: {},
    });

    expect(release.body.released).toEqual({
      legalName: "Ana María Restrepo Gil",
      documentNumber: "1020304050",
      residenceAddress: "Carrera 43A 1-50, Medellín",
    });
    expect(release.body.released).not.toHaveProperty("documentType");
  });
});

/// The delivery record says a disclosure is approved by a party other than the one
/// that asks for it. That holds per request, not by how scopes happen to be handed
/// out: these partners hold every disclosure scope and still cannot cross the line.
describe("separation of parties, enforced per request", () => {
  let desk: { id: string; partnerKey: string; secret: string };
  let office: { id: string; partnerKey: string; secret: string };

  beforeEach(async () => {
    const all: Scope[] = ["disclosures:request", "disclosures:read", "disclosures:approve"];
    desk = await partner("bank-desk", all);
    office = await partner("compliance-office-2", all);
  });

  async function requestBy(by: { partnerKey: string; secret: string }) {
    return signedRequest(app, {
      method: "post",
      path: "/v1/disclosures",
      partnerKey: by.partnerKey,
      secret: by.secret,
      body: {
        targetCommitment: commitment,
        requesterRef: "SFC-2026-0311",
        justification: JUSTIFICATION,
        legalBasis: "art. 326",
        scope: ["identity.legalName"],
      },
    });
  }

  function decide(by: { partnerKey: string; secret: string }, id: string, body: Record<string, unknown>, actorRef?: string) {
    return signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${id}/decision`,
      partnerKey: by.partnerKey,
      secret: by.secret,
      actorRef,
      body,
    });
  }

  function release(by: { partnerKey: string; secret: string }, id: string) {
    return signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${id}/release`,
      partnerKey: by.partnerKey,
      secret: by.secret,
      body: {},
    });
  }

  it("refuses an approval from the partner that made the request, even holding the approval scope", async () => {
    const request = await requestBy(desk);
    const response = await decide(desk, request.body.id, { decision: "APPROVED", decidedBy: "someone-else" });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("disclosure_self_decision");
    const stored = await prisma.disclosureRequest.findUniqueOrThrow({ where: { id: request.body.id } });
    expect(stored.status).toBe("PENDING");
    expect(stored.decidedByPartnerId).toBeNull();
  });

  it("refuses a denial from it too: deciding is the other party's, either way", async () => {
    const request = await requestBy(desk);
    const response = await decide(desk, request.body.id, { decision: "DENIED" });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("disclosure_self_decision");
  });

  it("records who decided from the authenticated request, not from the body", async () => {
    const request = await requestBy(desk);
    const response = await decide(office, request.body.id, { decision: "APPROVED", decidedBy: "supervisor-19" }, "officer-7");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "APPROVED",
      decidedBy: "supervisor-19",
      decidedByPartnerKey: office.partnerKey,
      decidedByActor: "officer-7",
    });
    const stored = await prisma.disclosureRequest.findUniqueOrThrow({ where: { id: request.body.id } });
    expect(stored.decidedByPartnerId).toBe(office.id);
  });

  it("takes a decision without a declared name, since the record no longer rests on it", async () => {
    const request = await requestBy(desk);
    const response = await decide(office, request.body.id, { decision: "DENIED", note: "alcance excesivo" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "DENIED", decidedBy: null, decidedByPartnerKey: office.partnerKey, decidedByActor: null });
  });

  it("shows who decided to whoever reads the request afterwards", async () => {
    const request = await requestBy(desk);
    await decide(office, request.body.id, { decision: "APPROVED" }, "officer-7");

    const read = await signedRequest(app, {
      method: "get",
      path: `/v1/disclosures/${request.body.id}`,
      partnerKey: desk.partnerKey,
      secret: desk.secret,
    });
    expect(read.body).toMatchObject({ decidedByPartnerKey: office.partnerKey, decidedByActor: "officer-7" });
  });

  it("releases only to the partner that made the request", async () => {
    const request = await requestBy(desk);
    await decide(office, request.body.id, { decision: "APPROVED" });

    const byDecider = await release(office, request.body.id);
    expect(byDecider.status).toBe(403);
    expect(byDecider.body.code).toBe("disclosure_not_requester");
    expect(JSON.stringify(byDecider.body)).not.toContain("Restrepo");

    const byReader = await release(regulator, request.body.id);
    expect(byReader.status).toBe(403);
    expect(byReader.body.code).toBe("disclosure_not_requester");

    const stored = await prisma.disclosureRequest.findUniqueOrThrow({ where: { id: request.body.id } });
    expect(stored.status).toBe("APPROVED");

    const byRequester = await release(desk, request.body.id);
    expect(byRequester.status).toBe(200);
    expect(byRequester.body.released).toEqual({ legalName: "Ana María Restrepo Gil" });
  });

  it("does not tell another partner whether someone else's request was approved", async () => {
    const request = await requestBy(desk);
    const response = await release(office, request.body.id);
    expect(response.body.code).toBe("disclosure_not_requester");
  });

  it("releases once", async () => {
    const request = await requestBy(desk);
    await decide(office, request.body.id, { decision: "APPROVED" });

    expect((await release(desk, request.body.id)).status).toBe(200);
    const again = await release(desk, request.body.id);
    expect(again.status).toBe(403);
    expect(again.body.code).toBe("disclosure_not_approved");
  });

  /// The same rule is a check constraint, so a write that goes around the service
  /// cannot record a request as decided by the partner that made it.
  it("is refused by the database as well", async () => {
    const request = await requestBy(desk);
    await expect(
      prisma.disclosureRequest.update({
        where: { id: request.body.id },
        data: { status: "APPROVED", decidedByPartnerId: desk.id, decidedAt: new Date() },
      }),
    ).rejects.toThrow(/disclosure_requests_decider_is_not_requester/);
  });
});

describe("what the auditor can reconstruct afterwards", () => {
  it("leaves every step of the disclosure in the append-only log", async () => {
    const request = await openRequest(["identity.legalName"]);
    await signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${request.body.id}/decision`,
      partnerKey: compliance.partnerKey,
      secret: compliance.secret,
      body: { decision: "APPROVED", decidedBy: "compliance-officer-3" },
    });
    await signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${request.body.id}/release`,
      partnerKey: regulator.partnerKey,
      secret: regulator.secret,
      body: {},
    });
    await flushAccessLog();

    const entries = await prisma.accessLogEntry.findMany({ orderBy: { sequence: "asc" } });
    const steps = entries.map((entry) => `${entry.resourceType}:${entry.outcome}`);

    expect(steps).toContain("disclosure_request:granted");
    expect(steps).toContain("disclosure_release:granted");
    expect(entries.some((entry) => entry.actorRef === "supervisor-19")).toBe(true);
    expect(await verifyAccessLogIntegrity()).toMatchObject({ intact: true });
  });

  it("serves the history to a partner holding the audit scope", async () => {
    await openRequest();
    await flushAccessLog();

    const auditor = await partner("audit", ["audit:read"]);
    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log?resourceType=disclosure_request",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
    });

    expect(response.status).toBe(200);
    expect(response.body.entries.length).toBeGreaterThan(0);
    expect(response.body.entries[0]).toMatchObject({ resourceType: "disclosure_request" });
  });

  it("reports the chain intact through the integrity endpoint", async () => {
    await openRequest();
    await flushAccessLog();

    const auditor = await partner("audit", ["audit:read"]);
    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log/integrity",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ intact: true, brokenAtSequence: null, reason: null });
  });

  it("never lets the released attributes reach the access log", async () => {
    const request = await openRequest(["identity.legalName"]);
    await signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${request.body.id}/decision`,
      partnerKey: compliance.partnerKey,
      secret: compliance.secret,
      body: { decision: "APPROVED", decidedBy: "compliance-officer-3" },
    });
    await signedRequest(app, {
      method: "post",
      path: `/v1/disclosures/${request.body.id}/release`,
      partnerKey: regulator.partnerKey,
      secret: regulator.secret,
      body: {},
    });
    await flushAccessLog();

    const entries = await prisma.accessLogEntry.findMany();
    const serialized = JSON.stringify(entries, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain("Restrepo");
    expect(serialized).not.toContain("1020304050");
  });
});
