import type { HashFn } from "./poseidon.js";

export interface MerkleOpening {
  pathElements: string[];
  pathIndices: string[];
}

/// Recomputes a root from an opening exactly as the circuit's MerkleInclusion does.
export function rootFromOpening(hash: HashFn, leaf: bigint, opening: MerkleOpening, depth: number): bigint {
  if (opening.pathElements.length !== depth || opening.pathIndices.length !== depth) {
    throw new Error(`an opening of this tree has ${depth} levels`);
  }
  let node = leaf;
  for (let level = 0; level < depth; level += 1) {
    const sibling = BigInt(opening.pathElements[level]!);
    const bit = opening.pathIndices[level];
    if (bit !== "0" && bit !== "1") throw new Error("a path index is a bit");
    node = bit === "0" ? hash(node, sibling) : hash(sibling, node);
  }
  return node;
}
