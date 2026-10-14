import type { HashFn } from "./poseidon.js";

export interface MerkleOpening {
  pathElements: string[];
  pathIndices: string[];
}

export interface LeafUpdate {
  leafIndex: number;
  value: bigint;
  present: boolean;
}

/// Sparse Merkle tree over the same shape the circuit proves against: unfilled
/// positions hold the zero subtree digest, so an empty leaf is literally 0 and a
/// tree of a million positions costs only the nodes that were touched.
export class SparseMerkleTree {
  private readonly zeros: bigint[] = [];
  private readonly levels: Map<number, bigint>[] = [];

  constructor(
    readonly depth: number,
    private readonly hash: HashFn,
  ) {
    this.zeros.push(0n);
    for (let level = 0; level < depth; level += 1) {
      this.zeros.push(this.hash(this.zeros[level]!, this.zeros[level]!));
    }
    for (let level = 0; level <= depth; level += 1) this.levels.push(new Map());
  }

  static from(depth: number, hash: HashFn, leaves: Iterable<[number, bigint]>): SparseMerkleTree {
    const tree = new SparseMerkleTree(depth, hash);
    for (const [index, value] of leaves) tree.setLeaf(index, value);
    return tree;
  }

  get capacity(): number {
    return 2 ** this.depth;
  }

  get leafCount(): number {
    return this.levels[0]!.size;
  }

  leaves(): ReadonlyMap<number, bigint> {
    return this.levels[0]!;
  }

  leafAt(index: number): bigint | undefined {
    return this.levels[0]!.get(index);
  }

  setLeaf(index: number, value: bigint): void {
    this.requireIndex(index);
    if (value === 0n) throw new Error("a zero leaf is indistinguishable from an empty position");
    this.levels[0]!.set(index, value);
    this.recomputePath(index);
  }

  clearLeaf(index: number): void {
    this.requireIndex(index);
    this.levels[0]!.delete(index);
    this.recomputePath(index);
  }

  root(): bigint {
    return this.levels[this.depth]!.get(0) ?? this.zeros[this.depth]!;
  }

  opening(index: number): MerkleOpening {
    this.requireIndex(index);
    const pathElements: string[] = [];
    const pathIndices: string[] = [];
    let cursor = index;
    for (let level = 0; level < this.depth; level += 1) {
      const sibling = this.levels[level]!.get(cursor ^ 1) ?? this.zeros[level]!;
      pathElements.push(sibling.toString());
      pathIndices.push(String(cursor & 1));
      cursor = Math.floor(cursor / 2);
    }
    return { pathElements, pathIndices };
  }

  /// Recomputes a root from an opening the way the circuit does, which is what
  /// makes an opening checkable without a proving system.
  verifyOpening(leaf: bigint, opening: MerkleOpening): bigint {
    if (opening.pathElements.length !== this.depth || opening.pathIndices.length !== this.depth) {
      throw new Error(`an opening of this tree has ${this.depth} levels`);
    }
    let node = leaf;
    for (let level = 0; level < this.depth; level += 1) {
      const sibling = BigInt(opening.pathElements[level]!);
      const bit = opening.pathIndices[level];
      if (bit !== "0" && bit !== "1") throw new Error("a path index is a bit");
      node = bit === "0" ? this.hash(node, sibling) : this.hash(sibling, node);
    }
    return node;
  }

  private recomputePath(index: number): void {
    let cursor = index;
    for (let level = 0; level < this.depth; level += 1) {
      const parent = Math.floor(cursor / 2);
      const left = this.levels[level]!.get(parent * 2) ?? this.zeros[level]!;
      const right = this.levels[level]!.get(parent * 2 + 1) ?? this.zeros[level]!;
      const digest = this.hash(left, right);
      if (digest === this.zeros[level + 1]!) this.levels[level + 1]!.delete(parent);
      else this.levels[level + 1]!.set(parent, digest);
      cursor = parent;
    }
  }

  private requireIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.capacity) {
      throw new Error(`leaf index ${index} is outside a depth-${this.depth} tree`);
    }
  }
}

/// Replays the registry's leaf events in log order. The chain is the only place
/// where tree membership is authoritative, so a rebuild is this function fed
/// with `CredentialLeafUpdated` or `CountryLeafUpdated` in block order.
export function replayLeafUpdates(depth: number, hash: HashFn, updates: LeafUpdate[]): SparseMerkleTree {
  const tree = new SparseMerkleTree(depth, hash);
  for (const update of updates) {
    if (update.present) tree.setLeaf(update.leafIndex, update.value);
    else tree.clearLeaf(update.leafIndex);
  }
  return tree;
}
