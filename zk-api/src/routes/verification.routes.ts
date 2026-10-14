import { Router } from "express";
import type { Address } from "viem";

import { logAccess } from "../middleware/access-log.js";
import { requireScope } from "../middleware/partner-auth.js";
import { validate } from "../middleware/validate.js";
import { complianceOf } from "../services/compliance.service.js";
import {
  verificationStanding,
  verifyProof,
  type ProofCallData,
} from "../services/proof-verification.service.js";
import { assetSubjectParamSchema, verificationParamSchema, verifyProofSchema } from "./schemas.js";
import { optionalParam, param } from "./params.js";

export const verificationRouter: Router = Router();

/// Validating a proof answers two questions at once, and the response keeps them
/// apart: whether the proof is cryptographically sound, and whether the state it
/// was built against still holds. A sound proof against a superseded root is not
/// a compliant operation.
verificationRouter.post(
  "/verifications",
  logAccess("proof_verification"),
  requireScope("proofs:verify"),
  validate(verifyProofSchema),
  async (req, res) => {
    const { proof } = req.body as { proof: ProofCallData };
    const outcome = await verifyProof(proof, req.partner?.id);
    req.accessResource = { type: "proof_verification", id: outcome.id };
    res.status(201).json(outcome);
  },
);

verificationRouter.get(
  "/verifications/:verificationId",
  logAccess("proof_verification", (req) => optionalParam(req, "verificationId")),
  requireScope("proofs:read"),
  validate(verificationParamSchema, "params"),
  async (req, res) => {
    res.json(await verificationStanding(param(req, "verificationId")));
  },
);

verificationRouter.get(
  "/compliance/assets/:assetId/subjects/:subject",
  logAccess("compliance_state", (req) => {
    const assetId = optionalParam(req, "assetId");
    const subject = optionalParam(req, "subject");
    return assetId && subject ? `${assetId}/${subject}` : null;
  }),
  requireScope("compliance:read"),
  validate(assetSubjectParamSchema, "params"),
  async (req, res) => {
    res.json(await complianceOf(param(req, "assetId"), param(req, "subject") as Address));
  },
);
