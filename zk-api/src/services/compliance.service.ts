import type { Address } from "viem";

import { apiError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { resolveStatus, type ResolvedCredentialStatus } from "./issuer.service.js";
import * as registry from "./registry.service.js";

export interface ComplianceState {
  assetId: string;
  subject: Address;
  compliant: boolean;
  attestation: {
    issuedAt: string | null;
    expiresAt: string | null;
    nullifier: string | null;
  };
  epoch: {
    currentEpochEnd: string;
    epochLength: string;
  };
  checkedAt: string;
}

/// What the bank is allowed to learn about a position: whether it is compliant
/// and until when. Not who holds it, not where they live, not when their
/// credential runs out -- none of which this answer touches.
export async function complianceOf(assetId: string, subject: Address): Promise<ComplianceState> {
  const asset = BigInt(assetId);
  const at = { at: await registry.stateBlock() };
  if ((await registry.readCountryRoot(asset, at)) === 0n) {
    throw apiError.notFound("asset_not_registered", "no jurisdiction root published for that asset", { assetId });
  }

  const [attestation, currentEpochEnd, epochLength] = await Promise.all([
    registry.readAttestation(asset, subject, at),
    registry.readCurrentEpochEnd(at),
    registry.readEpochLength(at),
  ]);

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const compliant = attestation.expiresAt > nowSeconds;

  return {
    assetId,
    subject,
    compliant,
    attestation: {
      issuedAt: attestation.issuedAt === 0n ? null : new Date(Number(attestation.issuedAt) * 1000).toISOString(),
      expiresAt: attestation.expiresAt === 0n ? null : new Date(Number(attestation.expiresAt) * 1000).toISOString(),
      nullifier: attestation.expiresAt === 0n ? null : attestation.nullifier.toString(),
    },
    epoch: {
      currentEpochEnd: currentEpochEnd.toString(),
      epochLength: epochLength.toString(),
    },
    checkedAt: new Date().toISOString(),
  };
}

export interface CredentialStanding {
  commitment: string;
  status: ResolvedCredentialStatus;
  inRegistry: boolean;
  issuedAt: string;
  expiresAt: string;
  suspendedAt: string | null;
  revokedAt: string | null;
  credentialRoot: string;
}

/// The credential's state from its commitment alone, with the four states of the
/// lifecycle and nothing that identifies the holder. `inRegistry` is the one that
/// decides whether a proof can still be produced.
export async function credentialStanding(commitment: string): Promise<CredentialStanding> {
  const credential = await prisma.credential.findUnique({ where: { commitment } });
  if (!credential) {
    throw apiError.notFound("credential_not_found", "no credential holds that commitment", { commitment });
  }

  return {
    commitment,
    status: resolveStatus(credential),
    inRegistry: credential.inTree,
    issuedAt: credential.issuedAt.toISOString(),
    expiresAt: credential.expiresAt.toISOString(),
    suspendedAt: credential.suspendedAt?.toISOString() ?? null,
    revokedAt: credential.revokedAt?.toISOString() ?? null,
    credentialRoot: (await registry.readCredentialRoot({ at: await registry.stateBlock() })).toString(),
  };
}
