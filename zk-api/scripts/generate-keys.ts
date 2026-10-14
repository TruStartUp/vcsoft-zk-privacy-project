import { generateKeyPairSync, randomBytes } from "node:crypto";

/// Prints a full set of fresh secrets for a new environment. Nothing is written
/// to disk: the operator moves these into the secret manager by hand.
///
/// None of these can reconstruct a holder's credential secret. That value is
/// generated in the holder's wallet and never reaches this service.

const viewing = generateKeyPairSync("x25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(16);
const keyId = `vk-${new Date().toISOString().slice(0, 7)}`;

process.stdout.write(
  [
    `SUBJECT_REFERENCE_KEY=${randomBytes(32).toString("base64")}`,
    `DISCLOSURE_VIEWING_KEYS=${keyId}:${viewing.toString("base64")}`,
    `DISCLOSURE_ACTIVE_VIEWING_KEY=${keyId}`,
    `PARTNER_SECRET_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    `ACCESS_LOG_HMAC_KEY=${randomBytes(32).toString("base64")}`,
    "",
  ].join("\n"),
);
