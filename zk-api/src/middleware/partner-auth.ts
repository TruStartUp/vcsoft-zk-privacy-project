import type { NextFunction, Request, Response } from "express";

import { config } from "../config/index.js";
import { apiError } from "../lib/errors.js";
import { claimNonce } from "../lib/redis.js";
import { isWithinWindow, sha256Hex, signRequest, signaturesMatch } from "../lib/signing.js";
import { findPartner, hasScope, partnerSecret, type Scope } from "../services/partner.service.js";

export const HEADER_PARTNER_KEY = "x-partner-key";
export const HEADER_TIMESTAMP = "x-partner-timestamp";
export const HEADER_NONCE = "x-partner-nonce";
export const HEADER_SIGNATURE = "x-partner-signature";
export const HEADER_ACTOR = "x-partner-actor";

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/// Authenticates a partner by the signature over the request, not by a bearer
/// token: a leaked token is a standing grant, whereas a signature covers one
/// method, one path, one body and one moment. The nonce makes it single-use even
/// inside its window.
export async function requirePartner(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const partnerKey = header(req, HEADER_PARTNER_KEY);
  const timestamp = header(req, HEADER_TIMESTAMP);
  const nonce = header(req, HEADER_NONCE);
  const signature = header(req, HEADER_SIGNATURE);

  if (!partnerKey || !timestamp || !nonce || !signature) {
    throw apiError.unauthorized("missing_partner_credentials", "a signed request carries key, timestamp, nonce and signature", {
      required: [HEADER_PARTNER_KEY, HEADER_TIMESTAMP, HEADER_NONCE, HEADER_SIGNATURE],
    });
  }

  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds)) {
    throw apiError.unauthorized("malformed_timestamp", "the timestamp is unix seconds");
  }
  if (!isWithinWindow(seconds, Math.floor(Date.now() / 1000), config.partner.signatureWindowSeconds)) {
    throw apiError.unauthorized("signature_window_expired", "the signature falls outside the accepted window", {
      windowSeconds: config.partner.signatureWindowSeconds,
    });
  }

  if (nonce.length < 8 || nonce.length > 128) {
    throw apiError.unauthorized("malformed_nonce", "a nonce is between 8 and 128 characters");
  }

  const partner = await findPartner(partnerKey);
  if (!partner) throw apiError.unauthorized("unknown_partner", "no partner holds that key");
  if (partner.status !== "ACTIVE") {
    throw apiError.forbidden("partner_suspended", "this partner is suspended", { partnerKey });
  }

  const body = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
  const expected = signRequest(partnerSecret(partner), {
    method: req.method,
    path: req.originalUrl,
    timestamp,
    nonce,
    body,
  });

  if (!signaturesMatch(expected, signature)) {
    throw apiError.unauthorized("invalid_signature", "the signature does not match the request");
  }

  const fresh = await claimNonce(partnerKey, nonce, config.partner.signatureWindowSeconds * 2);
  if (!fresh) {
    throw apiError.unauthorized("replayed_nonce", "this nonce was already used", { nonce });
  }

  req.partner = partner;
  req.actorRef = header(req, HEADER_ACTOR) ?? null;
  req.requestDigest = sha256Hex(body);
  next();
}

export interface ScopeGuard {
  (req: Request, res: Response, next: NextFunction): void;
  /// The scope this guard enforces, readable off the mounted route. The specification
  /// declares the same value per operation and a test compares the two, so a route
  /// whose authorization changes cannot leave the document saying otherwise.
  readonly requiredScope: Scope;
}

/// The scope is recorded before it is checked, so a refusal reaches the access
/// log naming the scope the caller was reaching for rather than an empty column.
export function requireScope(scope: Scope): ScopeGuard {
  const guard = (req: Request, _res: Response, next: NextFunction): void => {
    req.grantedScope = scope;
    if (!req.partner) throw apiError.unauthorized("missing_partner_credentials", "this route is authenticated");
    if (!hasScope(req.partner, scope)) {
      throw apiError.forbidden("insufficient_scope", "this partner does not hold the scope this route needs", {
        required: scope,
        granted: req.partner.scopes,
      });
    }
    next();
  };
  return Object.assign(guard, { requiredScope: scope });
}
