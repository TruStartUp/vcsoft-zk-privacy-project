import { randomBytes } from "node:crypto";

import type { Partner, PartnerStatus } from "@prisma/client";

import { config } from "../config/index.js";
import { apiError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { toBuffer, toBytes } from "../lib/bytes.js";
import { openSymmetric, sealSymmetric } from "../lib/sealed-box.js";

export const SCOPES = [
  "proofs:verify",
  "proofs:read",
  "compliance:read",
  "credentials:read",
  "credentials:issue",
  "credentials:activate",
  "credentials:revoke",
  "credentials:opening",
  "jurisdictions:write",
  "disclosures:request",
  "disclosures:read",
  "disclosures:approve",
  "audit:read",
  "issuer:admin",
] as const;

export type Scope = (typeof SCOPES)[number];

/// Binds the sealed secret to the partner it belongs to, so a row copied onto
/// another partner fails to authenticate instead of granting their scopes.
function partnerAad(partnerKey: string): Buffer {
  return Buffer.from(`vcsoft/zk-api/partner-secret/v1\n${partnerKey}`, "utf8");
}

export interface CreatedPartner {
  id: string;
  partnerKey: string;
  name: string;
  scopes: string[];
  /// Shown once. The service keeps only the sealed copy it needs to verify with.
  secret: string;
}

function freshSecret(partnerKey: string) {
  const secret = randomBytes(32).toString("base64url");
  const sealed = sealSymmetric(Buffer.from(secret, "utf8"), config.partner.secretEncryptionKey, partnerAad(partnerKey));
  return {
    secret,
    columns: {
      sealedSecret: toBytes(sealed.ciphertext),
      secretNonce: toBytes(sealed.nonce),
      secretTag: toBytes(sealed.authTag),
    },
  };
}

export async function createPartner(name: string, scopes: Scope[]): Promise<CreatedPartner> {
  const partnerKey = `pk_${randomBytes(12).toString("hex")}`;
  const { secret, columns } = freshSecret(partnerKey);

  const partner = await prisma.partner.create({
    data: { partnerKey, name, scopes, ...columns },
  });

  return { id: partner.id, partnerKey, name, scopes, secret };
}

export interface PartnerSummary {
  id: string;
  partnerKey: string;
  name: string;
  status: PartnerStatus;
  scopes: string[];
  updatedAt: string;
}

function summaryOf(partner: Partner): PartnerSummary {
  return {
    id: partner.id,
    partnerKey: partner.partnerKey,
    name: partner.name,
    status: partner.status,
    scopes: partner.scopes,
    updatedAt: partner.updatedAt.toISOString(),
  };
}

async function requirePartnerRow(partnerKey: string): Promise<Partner> {
  const partner = await findPartner(partnerKey);
  if (!partner) throw new Error(`no partner holds the key ${partnerKey}`);
  return partner;
}

export async function listPartners(): Promise<PartnerSummary[]> {
  const partners = await prisma.partner.findMany({ orderBy: { createdAt: "asc" } });
  return partners.map(summaryOf);
}

/// A suspended partner is refused with `partner_suspended` on its next request,
/// signature or not; nothing it did before is touched.
export async function setPartnerStatus(partnerKey: string, status: PartnerStatus): Promise<PartnerSummary> {
  await requirePartnerRow(partnerKey);
  return summaryOf(await prisma.partner.update({ where: { partnerKey }, data: { status } }));
}

/// Replaces the secret in place: the partner keeps its key, scopes and history, and
/// every signature made with the old secret stops verifying at once.
export async function rotatePartnerSecret(partnerKey: string): Promise<CreatedPartner> {
  await requirePartnerRow(partnerKey);
  const { secret, columns } = freshSecret(partnerKey);
  const partner = await prisma.partner.update({ where: { partnerKey }, data: columns });
  return { id: partner.id, partnerKey, name: partner.name, scopes: partner.scopes, secret };
}

export function partnerSecret(partner: Partner): string {
  try {
    return openSymmetric(
      {
        nonce: toBuffer(partner.secretNonce),
        authTag: toBuffer(partner.secretTag),
        ciphertext: toBuffer(partner.sealedSecret),
      },
      config.partner.secretEncryptionKey,
      partnerAad(partner.partnerKey),
    ).toString("utf8");
  } catch {
    throw apiError.internal("partner_secret_unreadable", "the stored partner secret did not authenticate", {
      partnerKey: partner.partnerKey,
    });
  }
}

export async function findPartner(partnerKey: string): Promise<Partner | null> {
  return prisma.partner.findUnique({ where: { partnerKey } });
}

export function hasScope(partner: Partner, scope: Scope): boolean {
  return partner.scopes.includes(scope);
}
