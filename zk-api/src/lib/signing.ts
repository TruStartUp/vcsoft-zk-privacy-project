import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_SCHEME = "VCSOFT-HMAC-SHA256";

export interface SignatureMaterial {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: Buffer;
}

export function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/// The exact bytes both sides sign. Method, full path with its query, the two
/// anti-replay fields and a digest of the body: change any of them and the
/// signature stops matching, so a partner cannot be replayed onto another route
/// or have their payload edited in flight.
export function canonicalRequest(material: SignatureMaterial): string {
  return [
    SIGNATURE_SCHEME,
    material.method.toUpperCase(),
    material.path,
    material.timestamp,
    material.nonce,
    sha256Hex(material.body),
  ].join("\n");
}

export function signRequest(secret: string, material: SignatureMaterial): string {
  return createHmac("sha256", secret).update(canonicalRequest(material), "utf8").digest("hex");
}

export function signaturesMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isWithinWindow(timestamp: number, nowSeconds: number, windowSeconds: number): boolean {
  return Math.abs(nowSeconds - timestamp) <= windowSeconds;
}
