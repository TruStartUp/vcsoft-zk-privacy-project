import { describe, expect, it } from "vitest";

import { FIELD_ORDER } from "../src/field.js";
import { generateHolderSecret, holderSecretHash, openHolderSecret, sealHolderSecret } from "../src/secret.js";
import { issuerModules } from "./helpers/issuer.js";

const passphrase = "correct horse battery staple";

describe("holder secret and its backup", () => {
  it("draws a non-zero element of the field, never the same twice", () => {
    const draws = new Set(Array.from({ length: 64 }, () => generateHolderSecret()));
    expect(draws.size).toBe(64);
    for (const secret of draws) {
      expect(secret > 0n && secret < FIELD_ORDER).toBe(true);
    }
  });

  it("opens the sealed backup back into the same secret", () => {
    const secret = generateHolderSecret();
    const backup = sealHolderSecret(secret, passphrase);
    expect(backup.ciphertext).not.toContain(secret.toString(16));
    expect(openHolderSecret(backup, passphrase)).toBe(secret);
  });

  it("refuses the wrong passphrase and a tampered envelope", () => {
    const backup = sealHolderSecret(generateHolderSecret(), passphrase);
    expect(() => openHolderSecret(backup, "another passphrase entirely")).toThrow();
    const tampered = { ...backup, ciphertext: Buffer.from("00".repeat(32), "hex").toString("base64") };
    expect(() => openHolderSecret(tampered, passphrase)).toThrow();
  });

  it("refuses a short passphrase", () => {
    expect(() => sealHolderSecret(1n, "short")).toThrow(/at least 12/);
  });

  it("is interchangeable with the issuer's reference backup in both directions", async () => {
    const { holderSecret } = await issuerModules();
    const secret = generateHolderSecret();
    expect(holderSecret.openHolderSecret(sealHolderSecret(secret, passphrase), passphrase)).toBe(secret);
    expect(openHolderSecret(holderSecret.sealHolderSecret(secret, passphrase), passphrase)).toBe(secret);
  });

  it("hashes the secret the way the issuer does", async () => {
    const { holderSecret } = await issuerModules();
    const secret = generateHolderSecret();
    expect(await holderSecretHash(secret)).toBe(await holderSecret.holderSecretHash(secret));
  });
});
