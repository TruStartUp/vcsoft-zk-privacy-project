import type { Express } from "express";
import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/registry.service.js", () => import("./helpers/registry-stub.js"));

import { createApp } from "../src/app.js";
import { config } from "../src/config/index.js";
import { prisma } from "../src/lib/prisma.js";
import { signRequest } from "../src/lib/signing.js";
import { flushAccessLog } from "../src/middleware/access-log.js";
import { createPartner } from "../src/services/partner.service.js";
import { resetDatabase } from "./helpers/database.js";
import { signedRequest } from "./helpers/signed-request.js";

let app: Express;
let auditor: { partnerKey: string; secret: string };
let issuerOnly: { partnerKey: string; secret: string };

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  await resetDatabase();
  auditor = await createPartner("regulator-audit", ["audit:read"]);
  issuerOnly = await createPartner("issuing-desk", ["credentials:issue"]);
});

describe("partner authentication", () => {
  it("lets a correctly signed request through", async () => {
    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
    });
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("entries");
  });

  it("refuses a request with no signature headers", async () => {
    const response = await import("supertest").then((m) => m.default(app).get("/v1/access-log"));
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("missing_partner_credentials");
  });

  it("refuses a signature made with the wrong secret", async () => {
    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: auditor.partnerKey,
      secret: randomBytes(32).toString("base64url"),
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("invalid_signature");
  });

  it("refuses a signature that names another partner's key", async () => {
    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: auditor.partnerKey,
      secret: issuerOnly.secret,
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("invalid_signature");
  });

  it("refuses an unknown partner key", async () => {
    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: "pk_does_not_exist",
      secret: auditor.secret,
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("unknown_partner");
  });

  it("refuses a suspended partner even with a correct signature", async () => {
    await prisma.partner.update({ where: { partnerKey: auditor.partnerKey }, data: { status: "SUSPENDED" } });
    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("partner_suspended");
  });
});

describe("the signature window", () => {
  it("refuses a signature older than the window", async () => {
    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
      timestamp: Math.floor(Date.now() / 1000) - config.partner.signatureWindowSeconds - 1,
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("signature_window_expired");
  });

  it("refuses a signature dated too far into the future", async () => {
    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
      timestamp: Math.floor(Date.now() / 1000) + config.partner.signatureWindowSeconds + 1,
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("signature_window_expired");
  });

  it("accepts one at the edge of the window", async () => {
    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
      timestamp: Math.floor(Date.now() / 1000) - config.partner.signatureWindowSeconds + 1,
    });
    expect(response.status).toBe(200);
  });

  it("refuses a timestamp that is not unix seconds", async () => {
    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
      timestamp: Number.NaN,
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("malformed_timestamp");
  });
});

describe("replay", () => {
  it("refuses the same signed request twice", async () => {
    const nonce = randomBytes(12).toString("hex");
    const first = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
      nonce,
    });
    expect(first.status).toBe(200);

    const replay = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
      nonce,
    });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("replayed_nonce");
  });
});

describe("what the signature covers", () => {
  it("refuses a body edited after it was signed", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(12).toString("hex");
    const signed = { admitted: [724] };
    const sent = { admitted: [724, 840] };

    const signature = signRequest(issuerOnly.secret, {
      method: "PUT",
      path: "/v1/assets/42/jurisdictions",
      timestamp,
      nonce,
      body: Buffer.from(JSON.stringify(signed), "utf8"),
    });

    const response = await signedRequest(app, {
      method: "put",
      path: "/v1/assets/42/jurisdictions",
      partnerKey: issuerOnly.partnerKey,
      secret: issuerOnly.secret,
      body: sent,
      timestamp: Number(timestamp),
      nonce,
      signature,
    });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("invalid_signature");
  });

  it("refuses a signature replayed onto another path", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(12).toString("hex");
    const signature = signRequest(auditor.secret, {
      method: "GET",
      path: "/v1/access-log",
      timestamp,
      nonce,
      body: Buffer.alloc(0),
    });

    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log/integrity",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
      timestamp: Number(timestamp),
      nonce,
      signature,
    });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("invalid_signature");
  });

  it("refuses a signature replayed onto a different query string", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(12).toString("hex");
    const signature = signRequest(auditor.secret, {
      method: "GET",
      path: "/v1/access-log?limit=1",
      timestamp,
      nonce,
      body: Buffer.alloc(0),
    });

    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log?limit=200",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
      timestamp: Number(timestamp),
      nonce,
      signature,
    });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("invalid_signature");
  });
});

describe("scopes", () => {
  it("refuses a partner that lacks the scope the route needs", async () => {
    const response = await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: issuerOnly.partnerKey,
      secret: issuerOnly.secret,
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("insufficient_scope");
    expect(response.body.details).toMatchObject({ required: "audit:read", granted: ["credentials:issue"] });
  });

  it("refuses the issuer-only routes to a partner holding only read scopes", async () => {
    const reader = await createPartner("bank-core", ["credentials:read"]);
    const response = await signedRequest(app, {
      method: "post",
      path: "/v1/issuer/state/rebuild",
      partnerKey: reader.partnerKey,
      secret: reader.secret,
      body: {},
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("insufficient_scope");
  });

  it("keeps scopes separate: audit cannot approve disclosures", async () => {
    const response = await signedRequest(app, {
      method: "post",
      path: "/v1/disclosures/00000000-0000-4000-8000-000000000000/decision",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
      body: { decision: "APPROVED", decidedBy: "auditor" },
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("insufficient_scope");
  });
});

describe("the access log written by the middleware", () => {
  it("records a granted request with the scope it was granted under", async () => {
    await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: auditor.partnerKey,
      secret: auditor.secret,
      actorRef: "supervisor-19",
    });
    await flushAccessLog();

    const entry = await prisma.accessLogEntry.findFirstOrThrow({ orderBy: { sequence: "desc" } });
    expect(entry).toMatchObject({
      partnerKey: auditor.partnerKey,
      actorRef: "supervisor-19",
      method: "GET",
      path: "/v1/access-log",
      scope: "audit:read",
      outcome: "granted",
      statusCode: 200,
    });
  });

  it("records an authentication that never reached a route", async () => {
    await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: auditor.partnerKey,
      secret: randomBytes(32).toString("base64url"),
    });
    await flushAccessLog();

    const entry = await prisma.accessLogEntry.findFirstOrThrow({ orderBy: { sequence: "desc" } });
    expect(entry).toMatchObject({
      partnerKey: auditor.partnerKey,
      resourceType: "authentication",
      outcome: "refused",
      statusCode: 401,
    });
  });

  it("records a refusal, so a run of denials is visible to an auditor", async () => {
    await signedRequest(app, {
      method: "get",
      path: "/v1/access-log",
      partnerKey: issuerOnly.partnerKey,
      secret: issuerOnly.secret,
    });
    await flushAccessLog();

    const entry = await prisma.accessLogEntry.findFirstOrThrow({ orderBy: { sequence: "desc" } });
    expect(entry).toMatchObject({ partnerKey: issuerOnly.partnerKey, outcome: "refused", statusCode: 403 });
  });
});
