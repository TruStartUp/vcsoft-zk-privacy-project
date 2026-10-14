import { Router } from "express";

import { logAccess } from "../middleware/access-log.js";
import { requireScope } from "../middleware/partner-auth.js";
import { validate } from "../middleware/validate.js";
import { reconcileCredentialTree, reconcileJurisdictionTree } from "../services/tree.service.js";
import { assetParamSchema } from "./schemas.js";
import { optionalParam, param } from "./params.js";

export const issuerRouter: Router = Router();

/// The recovery path, exposed rather than buried in a script: replay the
/// registry's leaf events, rebuild both trees, and say whether the result is the
/// root the registry holds.
issuerRouter.post("/issuer/state/rebuild", logAccess("issuer_state"), requireScope("issuer:admin"), async (_req, res) => {
  res.json(await reconcileCredentialTree());
});

issuerRouter.post(
  "/issuer/assets/:assetId/state/rebuild",
  logAccess("issuer_state", (req) => optionalParam(req, "assetId")),
  requireScope("issuer:admin"),
  validate(assetParamSchema, "params"),
  async (req, res) => {
    res.json(await reconcileJurisdictionTree(param(req, "assetId")));
  },
);
