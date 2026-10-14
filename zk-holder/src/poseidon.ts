import { buildPoseidon, type Poseidon } from "circomlibjs";

let building: Promise<Poseidon> | undefined;

export type HashFn = (...inputs: bigint[]) => bigint;

export async function poseidonHash(): Promise<HashFn> {
  building ??= buildPoseidon();
  const poseidon = await building;
  return (...inputs: bigint[]) => poseidon.F.toObject(poseidon(inputs));
}
