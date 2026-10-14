import { randomBytes } from "node:crypto";

export const FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const CREDENTIAL_TREE_DEPTH = 20;
export const JURISDICTION_TREE_DEPTH = 8;

export function isFieldElement(value: bigint): boolean {
  return value >= 0n && value < FIELD_ORDER;
}

/// Rejection sampling over 256-bit draws, so every non-zero field element is
/// equally likely and the nullifier cannot be enumerated.
export function randomFieldElement(): bigint {
  for (;;) {
    const candidate = BigInt(`0x${randomBytes(32).toString("hex")}`);
    if (candidate > 0n && candidate < FIELD_ORDER) return candidate;
  }
}
