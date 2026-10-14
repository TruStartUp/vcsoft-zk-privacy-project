import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { hashTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { config } from "../src/config/index.js";
import { FIELD_ORDER } from "../src/lib/field.js";
import {
  SECRET_DERIVATION_STATEMENT,
  activationTypedData,
  holderSecretFromSignature,
  holderSecretHash,
  holderSecretMaterial,
  holderTypedDataDomain,
  openHolderSecret,
  randomHolderSecret,
  recoverActivationSigner,
  sealHolderSecret,
  secretDerivationTypedData,
} from "../src/lib/holder-secret.js";
import { poseidonHash } from "../src/lib/poseidon.js";

const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const holder = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);

const signDerivation = (account = holder) => account.signTypedData(secretDerivationTypedData());

describe("deriving the secret from a wallet signature", () => {
  /// The whole scheme rests on this: sign the same message again in a year and
  /// get the same bytes. ECDSA over secp256k1 only guarantees it when the nonce
  /// is derived deterministically (RFC 6979), which is what every software
  /// wallet in this stack does and what a threshold signer does not.
  it("gives the same secret every time the same wallet signs the same message", async () => {
    const first = holderSecretFromSignature(await signDerivation());
    const second = holderSecretFromSignature(await signDerivation());
    expect(second).toBe(first);
  });

  it("gives different secrets to different wallets", async () => {
    expect(holderSecretFromSignature(await signDerivation(stranger))).not.toBe(
      holderSecretFromSignature(await signDerivation()),
    );
  });

  it("lands inside the scalar field the circuit works in", async () => {
    const secret = holderSecretFromSignature(await signDerivation());
    expect(secret).toBeGreaterThan(0n);
    expect(secret).toBeLessThan(FIELD_ORDER);
  });

  /// `v` says nothing the rest of the signature does not, and wallets disagree
  /// on whether it is 27/28 or 0/1. Dropping it removes a difference that would
  /// otherwise produce two secrets for one key.
  it("ignores the recovery byte, which wallets encode differently", async () => {
    const signature = await signDerivation();
    const withOtherV = `${signature.slice(0, 130)}1b` as Hex;
    const truncated = signature.slice(0, 130) as Hex;

    expect(holderSecretFromSignature(withOtherV)).toBe(holderSecretFromSignature(signature));
    expect(holderSecretFromSignature(truncated)).toBe(holderSecretFromSignature(signature));
  });

  /// (r, s) and (r, n - s) are both valid signatures of the same message. A
  /// client that did not fold s into its low half would derive a second, equally
  /// valid secret and lose the credential built on the first.
  it("folds a high-s signature onto the same secret as its canonical form", async () => {
    const signature = await signDerivation();
    const r = signature.slice(2, 66);
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const flipped = (SECP256K1_ORDER - s).toString(16).padStart(64, "0");
    const malleated = `0x${r}${flipped}1c` as Hex;

    expect(holderSecretFromSignature(malleated)).toBe(holderSecretFromSignature(signature));
  });

  it("refuses something that is not a signature", () => {
    expect(() => holderSecretFromSignature("0xdeadbeef")).toThrow(/64 or 65 bytes/);
    expect(() => holderSecretFromSignature(`0x${"00".repeat(65)}`)).toThrow(/zero/);
  });

  it("publishes only Poseidon of the secret", async () => {
    const hash = await poseidonHash();
    const { secret, secretHash } = await holderSecretMaterial(await signDerivation());
    expect(secretHash).toBe(hash(secret));
    expect(await holderSecretHash(secret)).toBe(secretHash);
  });
});

/// Determinism is a default of the signing library, not a property of ECDSA, and
/// the library this stack signs with exposes a switch that turns it off: viem's
/// `setSignEntropy` sets RFC 6979's optional extra entropy for every signature
/// the process makes afterwards. A holder application that called it -- or a viem
/// release that flipped the default -- would make every secret derived from then
/// on unreproducible, and nothing downstream would notice.
///
/// So the assumption is pinned here. This failing on an upgrade is the point: it
/// means somebody has to re-read this before the release ships.
describe("the assumption the whole scheme rests on", () => {
  it("signs with a deterministic nonce by default, and says so in the library", async () => {
    const require = createRequire(import.meta.url);
    const viemRoot = dirname(require.resolve("viem/package.json"));
    const signer = await readFile(resolve(viemRoot, "_esm/accounts/utils/sign.js"), "utf8");

    expect(signer).toMatch(/let extraEntropy = false/);
    expect(signer).toMatch(/export function setSignEntropy/);
  });
});

describe("the domain the wallet signs under", () => {
  /// A fixed, unstructured string is exactly the shape phishing already uses: no
  /// gas, no warning, and whoever collects the signature owns the credential for
  /// good. EIP-712 makes the wallet show the requesting origin and the content.
  it("is EIP-712, naming this deployment's registry and chain", () => {
    const domain = holderTypedDataDomain();
    expect(domain.chainId).toBe(config.chain.chainId);
    expect(domain.verifyingContract).toBe(config.chain.credentialRegistryAddress);
    expect(domain.version).toBe("1");
    expect(secretDerivationTypedData().message.statement).toBe(SECRET_DERIVATION_STATEMENT);
  });

  /// Without a deployment-specific domain the same wallet would produce the same
  /// secretHash everywhere, and two credentials at two institutions would be
  /// linkable by comparing one number.
  it("gives a different secret under a different deployment", async () => {
    const here = secretDerivationTypedData();
    const elsewhere = {
      ...here,
      domain: { ...here.domain, verifyingContract: `0x${"ab".repeat(20)}` as const },
    };

    const secretHere = holderSecretFromSignature(await holder.signTypedData(here));
    const secretElsewhere = holderSecretFromSignature(await holder.signTypedData(elsewhere));
    expect(secretElsewhere).not.toBe(secretHere);
  });

  it("is not the message activation is proved with", () => {
    const derivation = hashTypedData(secretDerivationTypedData());
    const activation = hashTypedData(activationTypedData("11111111-1111-4111-8111-111111111111", "7"));
    expect(activation).not.toBe(derivation);
  });
});

describe("proving possession at activation", () => {
  it("recovers the wallet that signed the activation", async () => {
    const credentialId = "11111111-1111-4111-8111-111111111111";
    const secretHash = "7";
    const signature = await holder.signTypedData(activationTypedData(credentialId, secretHash));

    expect(await recoverActivationSigner(credentialId, secretHash, signature)).toBe(holder.address);
  });

  it("does not carry over to another pending credential or another hash", async () => {
    const signature = await holder.signTypedData(
      activationTypedData("11111111-1111-4111-8111-111111111111", "7"),
    );

    expect(await recoverActivationSigner("22222222-2222-4222-8222-222222222222", "7", signature)).not.toBe(
      holder.address,
    );
    expect(await recoverActivationSigner("11111111-1111-4111-8111-111111111111", "8", signature)).not.toBe(
      holder.address,
    );
  });
});

/// The derivation is a convenience; this is what makes the credential survive.
/// Recovering a secret from a backup depends on nothing the wallet does, which
/// is the point: for the wallets these investors use, signature determinism is
/// undocumented at best (NOTAS-API.md §2.3).
describe("keeping the secret instead of rebuilding it", () => {
  const PASSPHRASE = "una frase larga de respaldo";

  it("draws a secret uniformly from the field", () => {
    const secrets = new Set(Array.from({ length: 32 }, () => randomHolderSecret()));
    expect(secrets.size).toBe(32);
    for (const secret of secrets) {
      expect(secret).toBeGreaterThan(0n);
      expect(secret).toBeLessThan(FIELD_ORDER);
    }
  });

  it("comes back from its backup, byte for byte", () => {
    const secret = randomHolderSecret();
    expect(openHolderSecret(sealHolderSecret(secret, PASSPHRASE), PASSPHRASE)).toBe(secret);
  });

  it("backs up a signature-derived secret just the same", async () => {
    const secret = holderSecretFromSignature(await signDerivation());
    expect(openHolderSecret(sealHolderSecret(secret, PASSPHRASE), PASSPHRASE)).toBe(secret);
  });

  it("refuses the wrong passphrase instead of returning something else", () => {
    const backup = sealHolderSecret(randomHolderSecret(), PASSPHRASE);
    expect(() => openHolderSecret(backup, "otra frase distinta")).toThrow();
  });

  it("refuses a backup whose ciphertext was edited", () => {
    const backup = sealHolderSecret(randomHolderSecret(), PASSPHRASE);
    const edited = Buffer.from(backup.ciphertext, "base64");
    edited.writeUInt8(edited.readUInt8(0) ^ 0xff, 0);
    expect(() => openHolderSecret({ ...backup, ciphertext: edited.toString("base64") }, PASSPHRASE)).toThrow();
  });

  it("never carries the secret in the clear, and never repeats a ciphertext", () => {
    const secret = randomHolderSecret();
    const first = sealHolderSecret(secret, PASSPHRASE);
    const second = sealHolderSecret(secret, PASSPHRASE);

    expect(JSON.stringify(first)).not.toContain(secret.toString(16));
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(second.salt).not.toBe(first.salt);
    expect(openHolderSecret(second, PASSPHRASE)).toBe(openHolderSecret(first, PASSPHRASE));
  });

  it("refuses a passphrase too short to be worth encrypting under", () => {
    expect(() => sealHolderSecret(randomHolderSecret(), "corta")).toThrow(/12 characters/);
  });

  it("refuses a backup written by a version it does not know", () => {
    const backup = sealHolderSecret(randomHolderSecret(), PASSPHRASE);
    expect(() => openHolderSecret({ ...backup, version: 2 }, PASSPHRASE)).toThrow(/unsupported backup version/);
  });
});
