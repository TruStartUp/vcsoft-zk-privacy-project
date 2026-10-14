import { config as loadDotenv } from "dotenv";
import Joi from "joi";

import { PROOF_SCHEMES, type ProofScheme } from "../lib/proof-scheme.js";

/// `.env` unless DOTENV_CONFIG_PATH names another file, so one checkout can run
/// against a second environment without touching the one the suite reads.
loadDotenv({ path: process.env.DOTENV_CONFIG_PATH || ".env" });

const BN254_SCALAR_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const base64Key = (bytes: number) =>
  Joi.string()
    .base64()
    .custom((value: string, helpers) => {
      if (Buffer.from(value, "base64").length !== bytes) {
        return helpers.error("any.invalid");
      }
      return value;
    }, `${bytes}-byte base64 key`);

const schema = Joi.object({
  NODE_ENV: Joi.string().valid("development", "test", "production").required(),
  LOG_LEVEL: Joi.string().valid("fatal", "error", "warn", "info", "debug", "trace", "silent").required(),

  API_PORT: Joi.number().port().required(),

  DATABASE_URL: Joi.string().uri({ scheme: ["postgresql", "postgres"] }).required(),
  REDIS_URL: Joi.string().uri({ scheme: ["redis", "rediss"] }).required(),

  CHAIN_RPC_URL: Joi.string().uri().required(),
  CHAIN_ID: Joi.number().integer().positive().required(),
  CREDENTIAL_REGISTRY_ADDRESS: Joi.string().pattern(/^0x[0-9a-fA-F]{40}$/).required(),
  COMPLIANCE_ATTESTOR_ADDRESS: Joi.string().pattern(/^0x[0-9a-fA-F]{40}$/).required(),
  REGISTRY_DEPLOYMENT_BLOCK: Joi.number().integer().min(0).required(),
  ISSUER_PRIVATE_KEY: Joi.string().pattern(/^0x[0-9a-fA-F]{64}$/).required(),
  CHAIN_CONFIRMATIONS: Joi.number().integer().min(1).max(64).default(1),
  CHAIN_RECEIPT_TIMEOUT_MS: Joi.number().integer().min(1_000).max(900_000).default(90_000),
  CHAIN_POLLING_INTERVAL_MS: Joi.number().integer().min(50).max(60_000).default(1_000),
  CHAIN_RPC_TIMEOUT_MS: Joi.number().integer().min(500).max(120_000).default(15_000),
  CHAIN_RPC_MAX_RETRIES: Joi.number().integer().min(0).max(10).default(4),
  CHAIN_RPC_RETRY_BASE_MS: Joi.number().integer().min(1).max(60_000).default(250),
  CHAIN_LOG_BLOCK_RANGE: Joi.number().integer().min(1).max(1_000_000).default(2_000),
  ISSUER_WRITE_QUEUE_LIMIT: Joi.number().integer().min(1).max(10_000).default(16),

  PROOF_SCHEME: Joi.string().valid(...PROOF_SCHEMES).required(),
  PROOF_VERIFICATION_KEY_PATH: Joi.string().required(),

  SUBJECT_REFERENCE_KEY: base64Key(32).required(),

  DISCLOSURE_VIEWING_KEYS: Joi.string().required(),
  DISCLOSURE_ACTIVE_VIEWING_KEY: Joi.string().required(),

  PARTNER_SECRET_ENCRYPTION_KEY: base64Key(32).required(),
  PARTNER_SIGNATURE_WINDOW_SECONDS: Joi.number().integer().min(1).max(3600).required(),

  ACCESS_LOG_HMAC_KEY: base64Key(32).required(),
}).unknown(true);

const { value, error } = schema.validate(process.env, { abortEarly: false });
if (error) {
  const details = error.details.map((d) => d.message).join("; ");
  throw new Error(`invalid_configuration: ${details}`);
}

const env = value as Record<string, string>;

function parseViewingKeys(raw: string): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const pair of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const separator = pair.indexOf(":");
    if (separator < 1) throw new Error(`invalid_configuration: DISCLOSURE_VIEWING_KEYS entry "${pair}"`);
    const id = pair.slice(0, separator);
    const material = Buffer.from(pair.slice(separator + 1), "base64");
    if (material.length !== 32) {
      throw new Error(`invalid_configuration: viewing key "${id}" is not 32 bytes`);
    }
    keys.set(id, material);
  }
  if (keys.size === 0) throw new Error("invalid_configuration: DISCLOSURE_VIEWING_KEYS is empty");
  return keys;
}

const viewingKeys = parseViewingKeys(env.DISCLOSURE_VIEWING_KEYS!);
const activeViewingKeyId = env.DISCLOSURE_ACTIVE_VIEWING_KEY!;
if (!viewingKeys.has(activeViewingKeyId)) {
  throw new Error(`invalid_configuration: DISCLOSURE_ACTIVE_VIEWING_KEY "${activeViewingKeyId}" has no material`);
}

export const config = {
  env: env.NODE_ENV as "development" | "test" | "production",
  logLevel: env.LOG_LEVEL!,
  apiPort: Number(env.API_PORT),

  databaseUrl: env.DATABASE_URL!,
  redisUrl: env.REDIS_URL!,

  chain: {
    rpcUrl: env.CHAIN_RPC_URL!,
    chainId: Number(env.CHAIN_ID),
    credentialRegistryAddress: env.CREDENTIAL_REGISTRY_ADDRESS! as `0x${string}`,
    complianceAttestorAddress: env.COMPLIANCE_ATTESTOR_ADDRESS! as `0x${string}`,
    registryDeploymentBlock: BigInt(env.REGISTRY_DEPLOYMENT_BLOCK!),
    issuerPrivateKey: env.ISSUER_PRIVATE_KEY! as `0x${string}`,
    confirmations: Number(env.CHAIN_CONFIRMATIONS),
    receiptTimeoutMs: Number(env.CHAIN_RECEIPT_TIMEOUT_MS),
    pollingIntervalMs: Number(env.CHAIN_POLLING_INTERVAL_MS),
    rpcTimeoutMs: Number(env.CHAIN_RPC_TIMEOUT_MS),
    rpcMaxRetries: Number(env.CHAIN_RPC_MAX_RETRIES),
    rpcRetryBaseMs: Number(env.CHAIN_RPC_RETRY_BASE_MS),
    logBlockRange: Number(env.CHAIN_LOG_BLOCK_RANGE),
  },

  issuer: {
    writeQueueLimit: Number(env.ISSUER_WRITE_QUEUE_LIMIT),
  },

  /// The proving scheme this deployment verifies, and the verifying key of the circuit
  /// under it. Both move together: a key from another scheme rejects every proof.
  proof: {
    scheme: env.PROOF_SCHEME! as ProofScheme,
    verificationKeyPath: env.PROOF_VERIFICATION_KEY_PATH!,
  },

  subjectReferenceKey: Buffer.from(env.SUBJECT_REFERENCE_KEY!, "base64"),

  disclosure: {
    viewingKeys,
    activeViewingKeyId,
  },

  partner: {
    secretEncryptionKey: Buffer.from(env.PARTNER_SECRET_ENCRYPTION_KEY!, "base64"),
    signatureWindowSeconds: Number(env.PARTNER_SIGNATURE_WINDOW_SECONDS),
  },

  accessLogHmacKey: Buffer.from(env.ACCESS_LOG_HMAC_KEY!, "base64"),
} as const;

export { BN254_SCALAR_ORDER };
