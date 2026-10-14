import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { randomFieldElement } from "./field.js";
import { poseidonHash } from "./poseidon.js";

/// The credential secret is generated once, on the holder's side, and kept.
/// Only `secretHash = Poseidon(secret)` ever leaves the holder's application.
export function generateHolderSecret(): bigint {
  return randomFieldElement();
}

export async function holderSecretHash(secret: bigint): Promise<bigint> {
  return (await poseidonHash())(secret);
}

/// Same envelope as the issuer's reference: scrypt, AES-256-GCM, versioned AAD.
const BACKUP_VERSION = 1;
const BACKUP_AAD = Buffer.from(`vcsoft/zk-api/holder-secret-backup/v${BACKUP_VERSION}`, "utf8");
const SCRYPT = { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;
export const MIN_PASSPHRASE_LENGTH = 12;

export interface HolderSecretBackup {
  version: number;
  kdf: "scrypt";
  params: { N: number; r: number; p: number };
  salt: string;
  nonce: string;
  authTag: string;
  ciphertext: string;
}

function backupKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(Buffer.from(passphrase.normalize("NFKC"), "utf8"), salt, 32, { ...params, maxmem: SCRYPT.maxmem });
}

export function sealHolderSecret(secret: bigint, passphrase: string): HolderSecretBackup {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`a backup passphrase is at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = backupKey(passphrase, salt, SCRYPT);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(BACKUP_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(secret.toString(16).padStart(64, "0"), "hex")),
      cipher.final(),
    ]);
    return {
      version: BACKUP_VERSION,
      kdf: "scrypt",
      params: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  } finally {
    key.fill(0);
  }
}

export function openHolderSecret(backup: HolderSecretBackup, passphrase: string): bigint {
  if (backup.version !== BACKUP_VERSION || backup.kdf !== "scrypt") {
    throw new Error(`unsupported backup version ${backup.version}`);
  }
  const key = backupKey(passphrase, Buffer.from(backup.salt, "base64"), backup.params);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(backup.nonce, "base64"));
    decipher.setAAD(BACKUP_AAD);
    decipher.setAuthTag(Buffer.from(backup.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(backup.ciphertext, "base64")),
      decipher.final(),
    ]);
    return BigInt(`0x${plaintext.toString("hex")}`);
  } finally {
    key.fill(0);
  }
}
