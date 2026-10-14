/// Order of the BN254 scalar field, the field the circuit and both trees live in.
export const FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const CREDENTIAL_TREE_DEPTH = 20;
export const JURISDICTION_TREE_DEPTH = 8;
export const COUNTRY_CODE_BITS = 16;
export const TIMESTAMP_BITS = 64;

export function isFieldElement(value: bigint): boolean {
  return value >= 0n && value < FIELD_ORDER;
}

export function requireFieldElement(value: bigint, label: string): bigint {
  if (!isFieldElement(value)) throw new Error(`${label} is not a canonical field element`);
  return value;
}

export function isCountryCode(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value < 2 ** COUNTRY_CODE_BITS;
}

export function isTimestamp(value: bigint): boolean {
  return value >= 0n && value < 1n << BigInt(TIMESTAMP_BITS);
}
