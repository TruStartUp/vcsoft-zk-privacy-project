import { Router } from "express";

import { logAccess } from "../middleware/access-log.js";
import { requireScope } from "../middleware/partner-auth.js";
import { validate } from "../middleware/validate.js";
import { credentialStanding } from "../services/compliance.service.js";
import {
  activateCredential,
  cancelPendingCredential,
  credentialOpening,
  jurisdictionOpening,
  registerVerification,
  reinstateCredential,
  revokeCredential,
  setAdmittedJurisdictions,
  suspendCredential,
} from "../services/issuer.service.js";
import {
  activateCredentialSchema,
  assetParamSchema,
  commitmentParamSchema,
  credentialIdParamSchema,
  issueCredentialSchema,
  jurisdictionOpeningParamSchema,
  removeCredentialSchema,
  setJurisdictionsSchema,
} from "./schemas.js";
import { optionalParam, param } from "./params.js";

export const credentialsRouter: Router = Router();

/// Issuance, first step. The identity check itself is the bank's, and arrives
/// here as a verdict: this service turns an approved verdict into a credential
/// that is not usable yet, because the value at the heart of it belongs to the
/// holder and has not been supplied.
credentialsRouter.post(
  "/credentials",
  logAccess("credential"),
  requireScope("credentials:issue"),
  validate(issueCredentialSchema),
  async (req, res) => {
    const { kycSubjectId, holderAddress, verification, identity } = req.body as {
      kycSubjectId: string;
      holderAddress: string;
      verification: { approved: boolean; countryCode: number; expiresAt: Date; reference: string };
      identity: Record<string, unknown> & { legalName: string; documentType: string; documentNumber: string; countryCode: number };
    };

    const pending = await registerVerification({
      kycSubjectId,
      holderAddress,
      approved: verification.approved,
      countryCode: verification.countryCode,
      expiresAt: new Date(verification.expiresAt),
      verificationRef: verification.reference,
      identity,
    });

    req.accessResource = { type: "credential", id: pending.credentialId };
    res.status(201).json(pending);
  },
);

/// Issuance, second step. The holder's wallet supplies Poseidon(secret) and
/// proves it is the wallet the identity check was performed against. Only now is
/// the leaf built and the root published.
credentialsRouter.post(
  "/credentials/:credentialId/activation",
  logAccess("credential", (req) => optionalParam(req, "credentialId")),
  requireScope("credentials:activate"),
  validate(credentialIdParamSchema, "params"),
  validate(activateCredentialSchema),
  async (req, res) => {
    const { secretHash, signature } = req.body as { secretHash: string; signature: `0x${string}` };
    const issued = await activateCredential(param(req, "credentialId"), { secretHash, signature });

    req.accessResource = { type: "credential", id: issued.commitment };
    res.status(201).json(issued);
  },
);

/// An enrolment the holder never completed. Nothing was published for it, and
/// leaving it in place would hold the subject's one live slot for good.
credentialsRouter.post(
  "/credentials/:credentialId/cancellation",
  logAccess("credential", (req) => optionalParam(req, "credentialId")),
  requireScope("credentials:revoke"),
  validate(credentialIdParamSchema, "params"),
  async (req, res) => {
    res.json(await cancelPendingCredential(param(req, "credentialId")));
  },
);

credentialsRouter.get(
  "/credentials/:commitment",
  logAccess("credential", (req) => optionalParam(req, "commitment")),
  requireScope("credentials:read"),
  validate(commitmentParamSchema, "params"),
  async (req, res) => {
    res.json(await credentialStanding(param(req, "commitment")));
  },
);

/// Read-only and separate from `issuer:admin`: the platform that builds proofs for
/// the holder needs openings, and nothing else the administrator can do.
credentialsRouter.get(
  "/credentials/:commitment/opening",
  logAccess("credential_opening", (req) => optionalParam(req, "commitment")),
  requireScope("credentials:opening"),
  validate(commitmentParamSchema, "params"),
  async (req, res) => {
    res.json(await credentialOpening(param(req, "commitment")));
  },
);

credentialsRouter.post(
  "/credentials/:commitment/revocation",
  logAccess("credential", (req) => optionalParam(req, "commitment")),
  requireScope("credentials:revoke"),
  validate(commitmentParamSchema, "params"),
  validate(removeCredentialSchema),
  async (req, res) => {
    const { closeRootWindow } = req.body as { closeRootWindow: boolean };
    res.json(await revokeCredential(param(req, "commitment"), closeRootWindow));
  },
);

credentialsRouter.post(
  "/credentials/:commitment/suspension",
  logAccess("credential", (req) => optionalParam(req, "commitment")),
  requireScope("credentials:revoke"),
  validate(commitmentParamSchema, "params"),
  validate(removeCredentialSchema),
  async (req, res) => {
    const { closeRootWindow } = req.body as { closeRootWindow: boolean };
    res.json(await suspendCredential(param(req, "commitment"), closeRootWindow));
  },
);

credentialsRouter.delete(
  "/credentials/:commitment/suspension",
  logAccess("credential", (req) => optionalParam(req, "commitment")),
  requireScope("credentials:revoke"),
  validate(commitmentParamSchema, "params"),
  async (req, res) => {
    res.json(await reinstateCredential(param(req, "commitment")));
  },
);

credentialsRouter.put(
  "/assets/:assetId/jurisdictions",
  logAccess("asset_jurisdictions", (req) => optionalParam(req, "assetId")),
  requireScope("jurisdictions:write"),
  validate(assetParamSchema, "params"),
  validate(setJurisdictionsSchema),
  async (req, res) => {
    const { admitted, closeRootWindow } = req.body as { admitted: number[]; closeRootWindow: boolean };
    res.json(await setAdmittedJurisdictions(param(req, "assetId"), admitted, closeRootWindow));
  },
);

credentialsRouter.get(
  "/assets/:assetId/jurisdictions/:countryCode/opening",
  logAccess("jurisdiction_opening", (req) => optionalParam(req, "assetId")),
  requireScope("credentials:opening"),
  validate(jurisdictionOpeningParamSchema, "params"),
  async (req, res) => {
    res.json(await jurisdictionOpening(param(req, "assetId"), Number(param(req, "countryCode"))));
  },
);
