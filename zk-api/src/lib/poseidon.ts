import { buildPoseidon, type Poseidon } from "circomlibjs";

let instance: Poseidon | undefined;
let building: Promise<Poseidon> | undefined;

/// The same permutation the circuit uses. Every commitment, nullifier and tree
/// node in this service has to agree with it bit for bit, so there is exactly
/// one implementation and everything routes through it.
export async function loadPoseidon(): Promise<Poseidon> {
  if (instance) return instance;
  building ??= buildPoseidon().then((built) => {
    instance = built;
    return built;
  });
  return building;
}

export type HashFn = (...inputs: bigint[]) => bigint;

export async function poseidonHash(): Promise<HashFn> {
  const poseidon = await loadPoseidon();
  return (...inputs: bigint[]) => poseidon.F.toObject(poseidon(inputs));
}
