import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { Prisma } from "@prisma/client";
import type { Express, Request, Response } from "express";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/registry.service.js", () => import("./helpers/registry-stub.js"));

import { createApp } from "../src/app.js";
import { config } from "../src/config/index.js";
import { prisma } from "../src/lib/prisma.js";
import { signRequest } from "../src/lib/signing.js";
import { flushAccessLog } from "../src/middleware/access-log.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { verifyAccessLogIntegrity } from "../src/services/access-log.service.js";
import { registerVerification } from "../src/services/issuer.service.js";
import { createPartner } from "../src/services/partner.service.js";
import { buildCredentialTree } from "../src/services/tree.service.js";
import { resetDatabase } from "./helpers/database.js";
import { activationSignature, holderSecretOf, holderWallet } from "./helpers/holder.js";
import { resetRegistryStub, state } from "./helpers/registry-stub.js";
import { signedRequest } from "./helpers/signed-request.js";

/// What the stress runs found: tree changes waiting on the advisory lock each held a
/// pooled connection, so a burst of activations starved every other query -- requests
/// failed with a raw 500 and access log entries were dropped -- and a request whose
/// caller hung up before the answer was processed and never logged.

let server: Express;
const issuerLimit = config.issuer as { writeQueueLimit: number };
const defaultLimit = issuerLimit.writeQueueLimit;

beforeAll(() => {
  server = createApp();
});

beforeEach(async () => {
  await resetDatabase();
  resetRegistryStub();
});

afterEach(() => {
  issuerLimit.writeQueueLimit = defaultLimit;
  state.publicationGate = null;
});

async function pendingActivations(count: number, prefix: string) {
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const subject = `${prefix}-${i}`;
      const wallet = holderWallet(subject);
      const pending = await registerVerification({
        kycSubjectId: subject,
        holderAddress: wallet.address,
        approved: true,
        countryCode: 170,
        expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        verificationRef: `VF-${subject}`,
        identity: { legalName: `Holder ${subject}`, documentType: "CC", documentNumber: subject, countryCode: 170 },
      });
      const { secretHash } = await holderSecretOf(wallet);
      return {
        credentialId: pending.credentialId,
        body: { secretHash: secretHash.toString(), signature: await activationSignature(wallet, pending.credentialId, secretHash) },
      };
    }),
  );
}

function closeGate(): () => void {
  let open!: () => void;
  state.publicationGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return open;
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("tree changes under a burst", () => {
  it("queue in memory, leave the pool to everyone else, and every request reaches the access log", async () => {
    issuerLimit.writeQueueLimit = 100;
    const issuer = await createPartner("issuing-desk", ["credentials:activate"]);
    const auditor = await createPartner("auditor", ["audit:read"]);
    const pending = await pendingActivations(40, "burst");

    const open = closeGate();
    const activations = pending.map((p) =>
      signedRequest(server, {
        method: "post",
        path: `/v1/credentials/${p.credentialId}/activation`,
        partnerKey: issuer.partnerKey,
        secret: issuer.secret,
        body: p.body,
      }).then((response) => response),
    );
    await until(() => state.publicationsAtGate === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const started = Date.now();
    await prisma.credential.count();
    const reads = await Promise.all(
      Array.from({ length: 30 }, () =>
        signedRequest(server, { method: "get", path: "/v1/access-log?limit=1", partnerKey: auditor.partnerKey, secret: auditor.secret }),
      ),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(reads.map((r) => r.status)).toEqual(Array(30).fill(200));

    open();
    const settled = await Promise.all(activations);
    expect(settled.map((r) => r.status)).toEqual(Array(40).fill(201));
    expect(new Set(settled.map((r) => r.body.leafIndex)).size).toBe(40);
    expect((await buildCredentialTree()).root()).toBe(state.credentialRoot);

    await flushAccessLog();
    expect(await prisma.accessLogEntry.count()).toBe(70);
    expect((await verifyAccessLogIntegrity()).intact).toBe(true);
  });

  it("refuse past the queue limit with 503 and Retry-After, and change nothing for the refused", async () => {
    issuerLimit.writeQueueLimit = 3;
    const issuer = await createPartner("issuing-desk", ["credentials:activate"]);
    const pending = await pendingActivations(6, "limit");

    const open = closeGate();
    const answers: { status: number; body: any; headers: Record<string, string> }[] = [];
    const activations = pending.map((p) =>
      signedRequest(server, {
        method: "post",
        path: `/v1/credentials/${p.credentialId}/activation`,
        partnerKey: issuer.partnerKey,
        secret: issuer.secret,
        body: p.body,
      }).then((response) => {
        answers.push(response);
        return response;
      }),
    );
    await until(() => answers.length === 3);
    open();
    const settled = await Promise.all(activations);

    const refused = settled.filter((r) => r.status === 503);
    expect(refused).toHaveLength(3);
    for (const response of refused) {
      expect(response.body.code).toBe("service_busy");
      expect(response.body.details.reason).toBe("issuer_write_queue_full");
      expect(response.headers["retry-after"]).toBe("5");
    }
    expect(settled.filter((r) => r.status === 201)).toHaveLength(3);
    expect(await prisma.credential.count({ where: { status: "PENDING", commitment: null, leafIndex: null } })).toBe(3);
  });
});

describe("a saturated database", () => {
  function respond(error: unknown) {
    const captured: { status?: number; body?: any; headers: Record<string, string> } = { headers: {} };
    const res = {
      setHeader: (name: string, value: string) => {
        captured.headers[name.toLowerCase()] = value;
      },
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
    } as unknown as Response;
    errorHandler(error, { originalUrl: "/v1/anything" } as Request, res, () => undefined);
    return captured;
  }

  it.each(["P2024", "P2028"])("answers %s as service_busy with Retry-After, not as an internal error", (code) => {
    const answer = respond(new Prisma.PrismaClientKnownRequestError("no connection", { code, clientVersion: Prisma.prismaVersion.client }));
    expect(answer.status).toBe(503);
    expect(answer.body.code).toBe("service_busy");
    expect(answer.body.details.reason).toBe("database_saturated");
    expect(answer.headers["retry-after"]).toBe("2");
  });

  it("still answers anything else as internal_error", () => {
    const answer = respond(new Error("boom"));
    expect(answer.status).toBe(500);
    expect(answer.body.code).toBe("internal_error");
  });
});

describe("a caller that hangs up before the answer", () => {
  it("still has the request it started logged, as aborted", async () => {
    const issuer = await createPartner("issuing-desk", ["credentials:activate"]);
    const [pending] = await pendingActivations(1, "hangup");
    const listening = server.listen(0);
    const { port } = listening.address() as AddressInfo;

    const open = closeGate();
    const path = `/v1/credentials/${pending!.credentialId}/activation`;
    const body = Buffer.from(JSON.stringify(pending!.body), "utf8");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(12).toString("hex");
    const outgoing = httpRequest({
      port,
      method: "POST",
      path,
      headers: {
        "content-type": "application/json",
        "content-length": body.length,
        "x-partner-key": issuer.partnerKey,
        "x-partner-timestamp": timestamp,
        "x-partner-nonce": nonce,
        "x-partner-signature": signRequest(issuer.secret, { method: "POST", path, timestamp, nonce, body }),
      },
    });
    outgoing.on("error", () => undefined);
    outgoing.end(body);

    await until(() => state.publicationsAtGate === 1);
    outgoing.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    open();
    const deadline = Date.now() + 10_000;
    while ((await prisma.credential.findUniqueOrThrow({ where: { id: pending!.credentialId } })).status !== "ACTIVE") {
      if (Date.now() > deadline) throw new Error("the activation did not complete");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    listening.close();

    await flushAccessLog();
    const entries = await prisma.accessLogEntry.findMany({ where: { path } });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe("aborted");
    expect(entries[0]!.statusCode).toBe(499);
    expect(entries[0]!.partnerKey).toBe(issuer.partnerKey);
    expect((await verifyAccessLogIntegrity()).intact).toBe(true);
  });
});
