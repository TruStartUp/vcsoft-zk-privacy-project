import { privateKeyToAccount } from "viem/accounts";

import type { Holder } from "./holder.js";

export interface StoredHolder {
  privateKey: `0x${string}`;
  secret: string;
  secretHash: string;
  countryCode: number;
  kycSubjectId: string;
  credentialId: string;
  expiresAt: string;
  commitment: string;
  leafIndex: number;
  revoked?: boolean;
}

export function serializeHolder(holder: Holder): StoredHolder {
  return {
    privateKey: holder.privateKey,
    secret: holder.secret.toString(),
    secretHash: holder.secretHash.toString(),
    countryCode: holder.countryCode,
    kycSubjectId: holder.kycSubjectId,
    credentialId: holder.credentialId!,
    expiresAt: holder.expiresAt!,
    commitment: holder.commitment!,
    leafIndex: holder.leafIndex!,
  };
}

export function restoreHolder(stored: StoredHolder): Holder {
  return {
    account: privateKeyToAccount(stored.privateKey),
    privateKey: stored.privateKey,
    secret: BigInt(stored.secret),
    secretHash: BigInt(stored.secretHash),
    countryCode: stored.countryCode,
    kycSubjectId: stored.kycSubjectId,
    credentialId: stored.credentialId,
    expiresAt: stored.expiresAt,
    commitment: stored.commitment,
    leafIndex: stored.leafIndex,
  };
}
