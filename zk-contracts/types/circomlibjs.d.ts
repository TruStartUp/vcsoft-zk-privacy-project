/// Mirrors zk-api/src/types/circomlibjs.d.ts. The integration suite builds its
/// Merkle trees with zk-api's own code, and that code imports circomlibjs, which
/// ships no types of its own.
declare module "circomlibjs" {
  export interface PoseidonField {
    toObject(value: unknown): bigint;
  }
  export interface Poseidon {
    (inputs: bigint[]): unknown;
    F: PoseidonField;
  }
  export function buildPoseidon(): Promise<Poseidon>;
}
