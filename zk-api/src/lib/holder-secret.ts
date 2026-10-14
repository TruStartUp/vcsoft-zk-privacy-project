import { createHash, randomBytes, scryptSync } from "node:crypto";

import { recoverTypedDataAddress, type Address, type Hex, type TypedDataDomain } from "viem";

import { config } from "../config/index.js";
import { FIELD_ORDER } from "./field.js";
import { poseidonHash } from "./poseidon.js";
import { openSymmetric, sealSymmetric } from "./sealed-box.js";

/// Everything the holder's wallet signs, and the two things the issuer does with
/// the result. Two messages, deliberately different:
///
///   1. `CredentialSecret` never leaves the wallet's own process. Its signature
///      is reduced to the field and becomes the credential secret. Whoever holds
///      that signature holds the secret for good, so it is never transmitted,
///      never logged, and never verified by this service.
///   2. `CredentialActivation` proves possession of the same wallet at the moment
///      the holder hands over `secretHash`. The issuer verifies this one, and it
///      carries no information about the first.
///
/// Both are EIP-712 rather than `personal_sign`, under a domain naming this
/// deployment's `CredentialRegistry` and chain. That buys three things:
///
///   - the wallet shows structured content and the requesting origin, so the
///     derivation message is not a blank string that any site can harvest with
///     no gas prompt and no warning;
///   - the same wallet yields a different secret on a different deployment, so
///     two credentials at two institutions are not linkable by comparing hashes;
///   - a signature obtained under someone else's domain does not produce the
///     hash this system expects.
///
/// That last point matters more than it looks. A leaked `secretHash` is enough
/// to brute-force the country and the expiry out of the published commitment:
/// there are a few hundred country codes and a few thousand plausible expiries,
/// so the search is around 10^5 Poseidon evaluations.

export const SECRET_DERIVATION_STATEMENT =
  "Derive the secret of my confidentiality credential. Signing this anywhere other than the " +
  "issuer's own application hands over control of the credential. This signature is never sent " +
  "to anyone.";

export const holderTypedDataTypes = {
  CredentialSecret: [{ name: "statement", type: "string" }],
  CredentialActivation: [
    { name: "credentialId", type: "string" },
    { name: "secretHash", type: "string" },
  ],
} as const;

/// Pinned, and versioned by `version`. Changing any field of this domain changes
/// every secret it ever produced, so a change is a reissuance of the whole
/// population and never a silent edit.
export function holderTypedDataDomain(): TypedDataDomain {
  return {
    name: "VCSoft Confidentiality Layer",
    version: "1",
    chainId: config.chain.chainId,
    verifyingContract: config.chain.credentialRegistryAddress,
  };
}

export function secretDerivationTypedData() {
  return {
    domain: holderTypedDataDomain(),
    types: { CredentialSecret: holderTypedDataTypes.CredentialSecret },
    primaryType: "CredentialSecret" as const,
    message: { statement: SECRET_DERIVATION_STATEMENT },
  };
}

export function activationTypedData(credentialId: string, secretHash: string) {
  return {
    domain: holderTypedDataDomain(),
    types: { CredentialActivation: holderTypedDataTypes.CredentialActivation },
    primaryType: "CredentialActivation" as const,
    message: { credentialId, secretHash },
  };
}

const SECRET_DOMAIN_TAG = "vcsoft/zk-api/holder-secret/v1";

/// Order of the secp256k1 group, needed to normalise `s` (see below).
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function signatureComponents(signature: Hex): { r: bigint; s: bigint } {
  const raw = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (raw.length !== 128 && raw.length !== 130) {
    throw new Error("a wallet signature is 64 or 65 bytes");
  }
  return {
    r: BigInt(`0x${raw.slice(0, 64)}`),
    s: BigInt(`0x${raw.slice(64, 128)}`),
  };
}

/// The credential secret, from the signature of `CredentialSecret`.
///
/// **This runs in the holder's application and nowhere else.** The issuer never
/// receives the signature this consumes; it receives only `secretHash`.
///
/// Two normalisations before hashing, both of which exist so that the same key
/// on the same message always lands on the same field element:
///
///   - the recovery byte `v` is dropped. It is redundant, and wallets disagree
///     on whether it is 27/28 or 0/1;
///   - `s` is folded to its low half, the EIP-2 canonical form. `(r, s)` and
///     `(r, n - s)` are both valid signatures of the same message, and a client
///     that does not normalise would otherwise produce a second, equally valid
///     secret.
///
/// The reduction is SHA-512 modulo the field order, so the bias is below 2^-250
/// and the output is uniform enough to satisfy the entropy requirement the
/// circuit's nullifier depends on.
export function holderSecretFromSignature(signature: Hex): bigint {
  const { r, s } = signatureComponents(signature);
  if (r === 0n || s === 0n) throw new Error("a signature component is zero");

  const canonicalS = s > SECP256K1_ORDER / 2n ? SECP256K1_ORDER - s : s;
  const material = Buffer.concat([
    Buffer.from(SECRET_DOMAIN_TAG, "utf8"),
    Buffer.from(r.toString(16).padStart(64, "0"), "hex"),
    Buffer.from(canonicalS.toString(16).padStart(64, "0"), "hex"),
  ]);

  const secret = BigInt(`0x${createHash("sha512").update(material).digest("hex")}`) % FIELD_ORDER;
  return secret === 0n ? 1n : secret;
}

/// The only value that leaves the holder's application.
export async function holderSecretHash(secret: bigint): Promise<bigint> {
  const hash = await poseidonHash();
  return hash(secret);
}

export interface HolderSecretMaterial {
  secret: bigint;
  secretHash: bigint;
}

export async function holderSecretMaterial(signature: Hex): Promise<HolderSecretMaterial> {
  const secret = holderSecretFromSignature(signature);
  return { secret, secretHash: await holderSecretHash(secret) };
}

/// The issuer's half: who signed the activation of this pending credential for
/// this `secretHash`. Recovery, not comparison, so the caller decides what the
/// expected address is.
export async function recoverActivationSigner(
  credentialId: string,
  secretHash: string,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({ ...activationTypedData(credentialId, secretHash), signature });
}

/// ---------------------------------------------------------------------------
/// Keeping the secret, which is what actually makes the credential survive.
///
/// The derivation above is a convenience, not a guarantee. Regenerating the
/// secret from a signature only works if the wallet signs deterministically, and
/// that is a property of the wallet, not of ECDSA (see NOTAS-API.md §2.3). For
/// the wallets this system's investors actually use it does not hold, and cannot
/// be made to hold from this side.
///
/// So the reference implementation keeps the secret rather than expecting to
/// rebuild it: generate once, seal under a passphrase the holder chooses, and
/// hand them the backup. Recovery is then a decryption, not a re-signature, and
/// none of it depends on how the wallet builds its nonce.
///
/// The issuer stores none of this and never sees it. It is here because the
/// client application needs one correct implementation to copy.

const BACKUP_VERSION = 1;
const BACKUP_AAD = `vcsoft/zk-api/holder-secret-backup/v${BACKUP_VERSION}`;
const SCRYPT = { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;

export interface HolderSecretBackup {
  version: number;
  kdf: "scrypt";
  params: { N: number; r: number; p: number };
  salt: string;
  nonce: string;
  authTag: string;
  ciphertext: string;
}

function backupKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(Buffer.from(passphrase.normalize("NFKC"), "utf8"), salt, 32, SCRYPT);
}

/// A secret drawn uniformly from the field, for a holder whose wallet cannot be
/// relied on to reproduce a signature. Rejection sampling, so the distribution
/// is flat and the nullifier is not enumerable.
export function randomHolderSecret(): bigint {
  for (;;) {
    const candidate = BigInt(`0x${randomBytes(32).toString("hex")}`);
    if (candidate > 0n && candidate < FIELD_ORDER) return candidate;
  }
}

export function sealHolderSecret(secret: bigint, passphrase: string): HolderSecretBackup {
  if (passphrase.length < 12) throw new Error("a backup passphrase is at least 12 characters");
  const salt = randomBytes(16);
  const key = backupKey(passphrase, salt);
  try {
    const envelope = sealSymmetric(
      Buffer.from(secret.toString(16).padStart(64, "0"), "hex"),
      key,
      Buffer.from(BACKUP_AAD, "utf8"),
    );
    return {
      version: BACKUP_VERSION,
      kdf: "scrypt",
      params: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      salt: salt.toString("base64"),
      nonce: envelope.nonce.toString("base64"),
      authTag: envelope.authTag.toString("base64"),
      ciphertext: envelope.ciphertext.toString("base64"),
    };
  } finally {
    key.fill(0);
  }
}

export function openHolderSecret(backup: HolderSecretBackup, passphrase: string): bigint {
  if (backup.version !== BACKUP_VERSION) throw new Error(`unsupported backup version ${backup.version}`);
  const key = backupKey(passphrase, Buffer.from(backup.salt, "base64"));
  try {
    const plaintext = openSymmetric(
      {
        nonce: Buffer.from(backup.nonce, "base64"),
        authTag: Buffer.from(backup.authTag, "base64"),
        ciphertext: Buffer.from(backup.ciphertext, "base64"),
      },
      key,
      Buffer.from(BACKUP_AAD, "utf8"),
    );
    return BigInt(`0x${plaintext.toString("hex")}`);
  } finally {
    key.fill(0);
  }
}
