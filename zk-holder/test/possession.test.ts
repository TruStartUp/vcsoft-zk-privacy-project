import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { activationTypedData, holderDomain, recoverActivationSigner, sameDomain, signActivation } from "../src/possession.js";
import { generateHolderSecret, holderSecretHash } from "../src/secret.js";
import { deployment, issuerModules } from "./helpers/issuer.js";

describe("proof of possession", () => {
  it("recovers to the holder's wallet", async () => {
    const holder = privateKeyToAccount(generatePrivateKey());
    const secretHash = await holderSecretHash(generateHolderSecret());
    const credentialId = "6f1c8f9e-3a52-4f43-9d2a-3f5d0c7d8e11";
    const signature = await signActivation(holder, deployment, credentialId, secretHash);
    expect(await recoverActivationSigner(deployment, credentialId, secretHash, signature)).toBe(holder.address);
  });

  it("is accepted by the issuer's own recovery under the same deployment", async () => {
    const { holderSecret } = await issuerModules();
    const holder = privateKeyToAccount(generatePrivateKey());
    const secretHash = await holderSecretHash(generateHolderSecret());
    const credentialId = "0b6f3f7e-91c4-4a8e-b0f2-7c6a5d4e3f21";
    const signature = await signActivation(holder, deployment, credentialId, secretHash);
    expect(await holderSecret.recoverActivationSigner(credentialId, secretHash.toString(), signature)).toBe(holder.address);
    expect(sameDomain(holderSecret.holderTypedDataDomain(), holderDomain(deployment))).toBe(true);
  });

  it("does not recover to the holder for another credential, hash or chain", async () => {
    const holder = privateKeyToAccount(generatePrivateKey());
    const secretHash = await holderSecretHash(generateHolderSecret());
    const credentialId = "6f1c8f9e-3a52-4f43-9d2a-3f5d0c7d8e11";
    const signature = await signActivation(holder, deployment, credentialId, secretHash);
    expect(await recoverActivationSigner(deployment, "00000000-0000-4000-8000-000000000000", secretHash, signature)).not.toBe(holder.address);
    expect(await recoverActivationSigner(deployment, credentialId, secretHash + 1n, signature)).not.toBe(holder.address);
    expect(await recoverActivationSigner({ ...deployment, chainId: 1 }, credentialId, secretHash, signature)).not.toBe(holder.address);
  });

  it("sends the hash as a decimal string, as the issuer reads it", async () => {
    const typed = activationTypedData(deployment, "id", 255n);
    expect(typed.message.secretHash).toBe("255");
  });
});
