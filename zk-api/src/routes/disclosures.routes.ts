import { Router } from "express";

import { logAccess } from "../middleware/access-log.js";
import { HEADER_SIGNATURE, requireScope } from "../middleware/partner-auth.js";
import { validate } from "../middleware/validate.js";
import {
  createDisclosureRequest,
  decideDisclosureRequest,
  disclosureView,
  findDisclosureRequest,
  releaseDisclosure,
  requestDigestOf,
  rotateEnvelopes,
} from "../services/disclosure.service.js";
import { disclosureDecisionSchema, disclosureParamSchema, disclosureRequestSchema, rotateViewingKeySchema } from "./schemas.js";
import { optionalParam, param } from "./params.js";

export const disclosuresRouter: Router = Router();

/// A request is evidence before it is a query: it names who asked, on whose
/// behalf, under what legal basis, over which attributes and when, and it carries
/// the partner's own signature over those bytes. Nothing here can be edited
/// afterwards -- a change of mind is a second request.
disclosuresRouter.post(
  "/disclosures",
  logAccess("disclosure_request"),
  requireScope("disclosures:request"),
  validate(disclosureRequestSchema),
  async (req, res) => {
    const body = req.body as {
      targetCommitment: string;
      requesterRef: string;
      justification: string;
      legalBasis: string;
      scope: string[];
    };
    const partner = req.partner!;
    const signature = req.headers[HEADER_SIGNATURE];

    const input = {
      partnerId: partner.id,
      requesterRef: body.requesterRef,
      justification: body.justification,
      legalBasis: body.legalBasis,
      scope: body.scope,
      targetCommitment: body.targetCommitment,
      requestSignature: Array.isArray(signature) ? (signature[0] ?? "") : (signature ?? ""),
    };

    const request = await createDisclosureRequest({ ...input, requestDigest: requestDigestOf(input) });
    req.accessResource = { type: "disclosure_request", id: request.id };
    res.status(201).json(disclosureView(request));
  },
);

disclosuresRouter.get(
  "/disclosures/:disclosureId",
  logAccess("disclosure_request", (req) => optionalParam(req, "disclosureId")),
  requireScope("disclosures:read"),
  validate(disclosureParamSchema, "params"),
  async (req, res) => {
    res.json(disclosureView(await findDisclosureRequest(param(req, "disclosureId"))));
  },
);

disclosuresRouter.post(
  "/disclosures/:disclosureId/decision",
  logAccess("disclosure_request", (req) => optionalParam(req, "disclosureId")),
  requireScope("disclosures:approve"),
  validate(disclosureParamSchema, "params"),
  validate(disclosureDecisionSchema),
  async (req, res) => {
    const { decision, decidedBy, note } = req.body as {
      decision: "APPROVED" | "DENIED";
      decidedBy?: string;
      note?: string;
    };
    const decider = { partnerId: req.partner!.id, actorRef: req.actorRef ?? null };
    res.json(disclosureView(await decideDisclosureRequest(param(req, "disclosureId"), decision, decider, decidedBy, note)));
  },
);

/// The only route in the service that returns personal data, and the only one
/// that needs a viewing key to answer. It releases the approved attributes, to the
/// partner that asked for them, and nothing else.
disclosuresRouter.post(
  "/disclosures/:disclosureId/release",
  logAccess("disclosure_release", (req) => optionalParam(req, "disclosureId")),
  requireScope("disclosures:read"),
  validate(disclosureParamSchema, "params"),
  async (req, res) => {
    res.json(await releaseDisclosure(param(req, "disclosureId"), req.partner!.id));
  },
);

disclosuresRouter.post(
  "/disclosures/viewing-keys/rotation",
  logAccess("viewing_key_rotation"),
  requireScope("issuer:admin"),
  validate(rotateViewingKeySchema),
  async (req, res) => {
    const { toViewingKeyId, batchSize } = req.body as { toViewingKeyId?: string; batchSize: number };
    res.json(await rotateEnvelopes(toViewingKeyId, batchSize));
  },
);
