import type { Express } from "express";
import { randomBytes } from "node:crypto";
import supertest from "supertest";

import { signRequest } from "../../src/lib/signing.js";
import { HEADER_ACTOR, HEADER_NONCE, HEADER_PARTNER_KEY, HEADER_SIGNATURE, HEADER_TIMESTAMP } from "../../src/middleware/partner-auth.js";

export interface SignedRequestOptions {
  method: "get" | "post" | "put" | "delete";
  path: string;
  partnerKey: string;
  secret: string;
  body?: unknown;
  timestamp?: number;
  nonce?: string;
  signature?: string;
  actorRef?: string;
}

export function signedRequest(app: Express, options: SignedRequestOptions) {
  const body = options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body), "utf8");
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomBytes(12).toString("hex");
  const signature =
    options.signature ??
    signRequest(options.secret, { method: options.method, path: options.path, timestamp, nonce, body });

  let request = supertest(app)[options.method](options.path)
    .set(HEADER_PARTNER_KEY, options.partnerKey)
    .set(HEADER_TIMESTAMP, timestamp)
    .set(HEADER_NONCE, nonce)
    .set(HEADER_SIGNATURE, signature);

  if (options.actorRef) request = request.set(HEADER_ACTOR, options.actorRef);
  if (options.body !== undefined) request = request.type("json").send(body.toString("utf8"));

  return request;
}
