import { createHash } from "node:crypto";

import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import {
  activationTypedData,
  holderSecretMaterial,
  secretDerivationTypedData,
  type HolderSecretMaterial,
} from "../../src/lib/holder-secret.js";
import {
  activateCredential,
  registerVerification,
  type IdentityVerificationResult,
  type IssuedCredential,
} from "../../src/services/issuer.service.js";

/// A stand-in for the holder's application: it owns the wallet, derives the
/// secret from a signature the issuer never sees, and hands over only the hash
/// plus a proof that the wallet is the one the identity check named.
export function holderWallet(seed: string): PrivateKeyAccount {
  const key = createHash("sha256").update(`holder/${seed}`, "utf8").digest("hex");
  return privateKeyToAccount(`0x${key}`);
}

export async function holderSecretOf(wallet: PrivateKeyAccount): Promise<HolderSecretMaterial> {
  return holderSecretMaterial(await wallet.signTypedData(secretDerivationTypedData()));
}

export async function activationSignature(
  wallet: PrivateKeyAccount,
  credentialId: string,
  secretHash: bigint,
): Promise<`0x${string}`> {
  return wallet.signTypedData(activationTypedData(credentialId, secretHash.toString()));
}

export interface IssuedForTest extends IssuedCredential {
  wallet: PrivateKeyAccount;
  secret: bigint;
  secretHash: bigint;
}

/// Both steps in one call, for the tests whose subject is what happens after a
/// credential exists.
export async function issueCredentialForHolder(
  verification: IdentityVerificationResult,
  wallet: PrivateKeyAccount = holderWallet(verification.kycSubjectId),
): Promise<IssuedForTest> {
  const pending = await registerVerification({ ...verification, holderAddress: wallet.address });
  const { secret, secretHash } = await holderSecretOf(wallet);
  const signature = await activationSignature(wallet, pending.credentialId, secretHash);
  const issued = await activateCredential(pending.credentialId, {
    secretHash: secretHash.toString(),
    signature,
  });
  return { ...issued, wallet, secret, secretHash };
}
