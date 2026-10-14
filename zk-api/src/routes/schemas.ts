import Joi from "joi";

import { PLONK_PROOF_WORDS } from "../lib/proof-codec.js";
import { DISCLOSURE_SCOPES } from "../services/disclosure.service.js";

const decimalField = Joi.string().pattern(/^\d{1,78}$/).required();
const hexWord = Joi.string().pattern(/^0x[0-9a-fA-F]{1,64}$/).required();
const address = Joi.string().pattern(/^0x[0-9a-fA-F]{40}$/).required();
const assetId = Joi.string().pattern(/^\d{1,78}$/).required();
const countryCode = Joi.number().integer().min(1).max(65535).required();
const commitment = Joi.string().pattern(/^\d{1,78}$/).required();

export const issueCredentialSchema = Joi.object({
  kycSubjectId: Joi.string().min(1).max(512).required(),
  holderAddress: address,
  verification: Joi.object({
    approved: Joi.boolean().required(),
    countryCode,
    expiresAt: Joi.date().iso().greater("now").required(),
    reference: Joi.string().min(1).max(256).required(),
  }).required(),
  identity: Joi.object({
    legalName: Joi.string().min(1).max(512).required(),
    documentType: Joi.string().min(1).max(64).required(),
    documentNumber: Joi.string().min(1).max(128).required(),
    countryCode,
    dateOfBirth: Joi.string().isoDate(),
    residenceAddress: Joi.string().max(1024),
    kycProvider: Joi.string().max(256),
    kycReference: Joi.string().max(256),
  })
    .unknown(true)
    .required(),
});

export const commitmentParamSchema = Joi.object({ commitment });

export const credentialIdParamSchema = Joi.object({
  credentialId: Joi.string().uuid().required(),
});

/// The holder never sends the signature the secret comes from. What arrives is
/// the hash, and a signature over a different message that proves the wallet
/// behind the identity check is the one sending it.
export const activateCredentialSchema = Joi.object({
  secretHash: commitment,
  signature: Joi.string().pattern(/^0x[0-9a-fA-F]{130}$/).required(),
});

export const assetParamSchema = Joi.object({ assetId });

export const assetSubjectParamSchema = Joi.object({ assetId, subject: address });

export const jurisdictionOpeningParamSchema = Joi.object({ assetId, countryCode });

export const setJurisdictionsSchema = Joi.object({
  admitted: Joi.array().items(Joi.number().integer().min(1).max(65535)).min(1).max(256).required(),
  closeRootWindow: Joi.boolean().default(true),
});

/// Defaults to closing the window, because the delivery record asks for
/// revocation to take effect immediately. An operator who would rather not
/// disturb in-flight proofs sets it to false and accepts the latency.
export const removeCredentialSchema = Joi.object({
  closeRootWindow: Joi.boolean().default(true),
});

const publicSignals = Joi.array().items(Joi.alternatives(hexWord, decimalField)).length(6).required();

/// One shape per proving scheme, told apart by their fields alone. The route accepts
/// both and the verification service refuses the one this deployment does not verify,
/// so an integrator who sends the wrong scheme is told exactly that instead of being
/// handed a verdict about numbers nobody could check.
export const groth16CallDataSchema = Joi.object({
  a: Joi.array().items(hexWord).length(2).required(),
  b: Joi.array().items(Joi.array().items(hexWord).length(2)).length(2).required(),
  c: Joi.array().items(hexWord).length(2).required(),
  signals: publicSignals,
});

export const plonkCallDataSchema = Joi.object({
  proof: Joi.array().items(hexWord).length(PLONK_PROOF_WORDS).required(),
  signals: publicSignals,
});

export const verifyProofSchema = Joi.object({
  proof: Joi.alternatives().try(groth16CallDataSchema, plonkCallDataSchema).required(),
});

export const verificationParamSchema = Joi.object({
  verificationId: Joi.string().uuid().required(),
});

export const disclosureRequestSchema = Joi.object({
  targetCommitment: commitment,
  requesterRef: Joi.string().min(1).max(256).required(),
  justification: Joi.string().min(20).max(4096).required(),
  legalBasis: Joi.string().min(1).max(512).required(),
  scope: Joi.array().items(Joi.string().valid(...DISCLOSURE_SCOPES)).min(1).required(),
});

export const disclosureParamSchema = Joi.object({
  disclosureId: Joi.string().uuid().required(),
});

export const disclosureDecisionSchema = Joi.object({
  decision: Joi.string().valid("APPROVED", "DENIED").required(),
  decidedBy: Joi.string().min(1).max(256),
  note: Joi.string().max(2048),
});

export const accessLogQuerySchema = Joi.object({
  partnerKey: Joi.string().max(128),
  resourceType: Joi.string().max(64),
  resourceId: Joi.string().max(256),
  from: Joi.date().iso(),
  to: Joi.date().iso(),
  limit: Joi.number().integer().min(1).max(200).default(50),
  cursor: Joi.string().pattern(/^\d{1,20}$/),
});

export const rotateViewingKeySchema = Joi.object({
  toViewingKeyId: Joi.string().min(1).max(128),
  batchSize: Joi.number().integer().min(1).max(1000).default(200),
});
