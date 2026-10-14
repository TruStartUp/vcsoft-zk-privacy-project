import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const HKDF_INFO = "vcsoft/zk-api/disclosure/v1";

export interface SealedEnvelope {
  viewingKeyId: string;
  ephemeralPublicKey: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
  aad: Buffer;
}

export function privateKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== KEY_LENGTH) throw new Error("an X25519 private key is 32 bytes");
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== KEY_LENGTH) throw new Error("an X25519 public key is 32 bytes");
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function rawPublicKey(key: KeyObject): Buffer {
  return key.export({ format: "der", type: "spki" }).subarray(X25519_SPKI_PREFIX.length);
}

export function publicKeyOf(privateRaw: Buffer): Buffer {
  return rawPublicKey(createPublicKey(privateKeyFromRaw(privateRaw)));
}

function deriveKey(sharedSecret: Buffer, ephemeralPublic: Buffer, recipientPublic: Buffer): Buffer {
  const salt = Buffer.concat([ephemeralPublic, recipientPublic]);
  return Buffer.from(hkdfSync("sha256", sharedSecret, salt, Buffer.from(HKDF_INFO, "utf8"), KEY_LENGTH));
}

/// Sealed with a key nobody but the viewing-key holder can derive: a fresh
/// X25519 keypair per record, agreed against the recipient's public half, run
/// through HKDF and used once for AES-256-GCM.
///
/// Sealing needs only the public half, so an operator can enrol holders without
/// ever holding the key that opens them. `aad` binds the ciphertext to the
/// record it belongs to, so a ciphertext moved onto another credential fails to
/// authenticate instead of decrypting into the wrong holder.
export function seal(
  plaintext: Buffer,
  recipientPublicRaw: Buffer,
  viewingKeyId: string,
  aad: Buffer,
): SealedEnvelope {
  const recipientPublic = publicKeyFromRaw(recipientPublicRaw);
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPublicRaw = rawPublicKey(ephemeral.publicKey);

  const sharedSecret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPublic });
  const key = deriveKey(sharedSecret, ephemeralPublicRaw, recipientPublicRaw);

  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  key.fill(0);
  sharedSecret.fill(0);

  return {
    viewingKeyId,
    ephemeralPublicKey: ephemeralPublicRaw,
    nonce,
    authTag: cipher.getAuthTag(),
    ciphertext,
    aad,
  };
}

export function open(envelope: SealedEnvelope, recipientPrivateRaw: Buffer): Buffer {
  const recipientPrivate = privateKeyFromRaw(recipientPrivateRaw);
  const recipientPublicRaw = rawPublicKey(createPublicKey(recipientPrivate));

  const sharedSecret = diffieHellman({
    privateKey: recipientPrivate,
    publicKey: publicKeyFromRaw(envelope.ephemeralPublicKey),
  });
  const key = deriveKey(sharedSecret, envelope.ephemeralPublicKey, recipientPublicRaw);

  const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce);
  decipher.setAAD(envelope.aad);
  decipher.setAuthTag(envelope.authTag);

  try {
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
  } finally {
    key.fill(0);
    sharedSecret.fill(0);
  }
}

/// Symmetric variant, for partner HMAC secrets: they belong to this service and
/// travel with it, so they need confidentiality at rest rather than a key
/// separation between who writes and who reads.
export interface SymmetricEnvelope {
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

export function sealSymmetric(plaintext: Buffer, key: Buffer, aad: Buffer): SymmetricEnvelope {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, authTag: cipher.getAuthTag(), ciphertext };
}

export function openSymmetric(envelope: SymmetricEnvelope, key: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(envelope.authTag);
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
}
