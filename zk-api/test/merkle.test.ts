import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { CREDENTIAL_TREE_DEPTH, JURISDICTION_TREE_DEPTH } from "../src/lib/field.js";
import { SparseMerkleTree, replayLeafUpdates, type LeafUpdate } from "../src/lib/merkle.js";
import { poseidonHash, type HashFn } from "../src/lib/poseidon.js";

const FIXTURE = resolve(import.meta.dirname, "../../zk-contracts/test/fixtures/compliance-proofs.json");

interface ProofFixture {
  roots: { credentialInitial: string; credentialCurrent: string; countryA: string; countryB: string };
  credentialLeaves: {
    initial: { leafIndex: number; commitment: string }[];
    current: { leafIndex: number; commitment: string }[];
  };
  countryLeaves: {
    assetA: { leafIndex: number; countryCode: number }[];
    assetB: { leafIndex: number; countryCode: number }[];
  };
}

let hash: HashFn;
let fixture: ProofFixture;

beforeAll(async () => {
  hash = await poseidonHash();
  fixture = JSON.parse(await readFile(FIXTURE, "utf8")) as ProofFixture;
});

describe("sparse merkle tree", () => {
  it("hashes an empty tree to the zero subtree digest", () => {
    const tree = new SparseMerkleTree(4, hash);
    let expected = 0n;
    for (let level = 0; level < 4; level += 1) expected = hash(expected, expected);
    expect(tree.root()).toBe(expected);
    expect(tree.leafCount).toBe(0);
  });

  it("gives an opening that recomputes the root the way the circuit does", () => {
    const tree = SparseMerkleTree.from(CREDENTIAL_TREE_DEPTH, hash, [
      [0, 111n],
      [7, 222n],
      [1023, 333n],
    ]);

    for (const [index, leaf] of [
      [0, 111n],
      [7, 222n],
      [1023, 333n],
    ] as [number, bigint][]) {
      expect(tree.verifyOpening(leaf, tree.opening(index))).toBe(tree.root());
    }
  });

  it("refuses an opening whose sibling was tampered with", () => {
    const tree = SparseMerkleTree.from(CREDENTIAL_TREE_DEPTH, hash, [[5, 999n]]);
    const opening = tree.opening(5);
    opening.pathElements[3] = (BigInt(opening.pathElements[3]!) + 1n).toString();
    expect(tree.verifyOpening(999n, opening)).not.toBe(tree.root());
  });

  it("returns to the previous root when a leaf is added and taken back out", () => {
    const tree = SparseMerkleTree.from(JURISDICTION_TREE_DEPTH, hash, [
      [0, 724n],
      [1, 250n],
    ]);
    const before = tree.root();

    tree.setLeaf(2, 840n);
    expect(tree.root()).not.toBe(before);

    tree.clearLeaf(2);
    expect(tree.root()).toBe(before);
  });

  it("does not depend on the order leaves were inserted in", () => {
    const ascending = SparseMerkleTree.from(CREDENTIAL_TREE_DEPTH, hash, [
      [0, 11n],
      [1, 22n],
      [900, 33n],
    ]);
    const descending = SparseMerkleTree.from(CREDENTIAL_TREE_DEPTH, hash, [
      [900, 33n],
      [1, 22n],
      [0, 11n],
    ]);
    expect(descending.root()).toBe(ascending.root());
  });

  it("refuses a zero leaf and an index outside the tree", () => {
    const tree = new SparseMerkleTree(JURISDICTION_TREE_DEPTH, hash);
    expect(() => tree.setLeaf(0, 0n)).toThrow(/zero leaf/);
    expect(() => tree.setLeaf(256, 724n)).toThrow(/outside a depth-8 tree/);
  });

  /// The roots the deployed contracts were tested against. If this service built
  /// its trees even slightly differently -- padding, hash arity, sibling order --
  /// every proof it handed out would fail on chain, and this is where that shows.
  it("reproduces the roots the on-chain fixtures were built with", () => {
    const initial = SparseMerkleTree.from(
      CREDENTIAL_TREE_DEPTH,
      hash,
      fixture.credentialLeaves.initial.map((leaf) => [leaf.leafIndex, BigInt(leaf.commitment)] as [number, bigint]),
    );
    expect(initial.root().toString()).toBe(fixture.roots.credentialInitial);

    const current = SparseMerkleTree.from(CREDENTIAL_TREE_DEPTH, hash, [
      ...fixture.credentialLeaves.initial.map((leaf) => [leaf.leafIndex, BigInt(leaf.commitment)] as [number, bigint]),
      ...fixture.credentialLeaves.current.map((leaf) => [leaf.leafIndex, BigInt(leaf.commitment)] as [number, bigint]),
    ]);
    expect(current.root().toString()).toBe(fixture.roots.credentialCurrent);

    const countryA = SparseMerkleTree.from(
      JURISDICTION_TREE_DEPTH,
      hash,
      fixture.countryLeaves.assetA.map((leaf) => [leaf.leafIndex, BigInt(leaf.countryCode)] as [number, bigint]),
    );
    expect(countryA.root().toString()).toBe(fixture.roots.countryA);

    const countryB = SparseMerkleTree.from(
      JURISDICTION_TREE_DEPTH,
      hash,
      fixture.countryLeaves.assetB.map((leaf) => [leaf.leafIndex, BigInt(leaf.countryCode)] as [number, bigint]),
    );
    expect(countryB.root().toString()).toBe(fixture.roots.countryB);
  });
});

describe("rebuilding a tree from the registry's leaf events", () => {
  it("lands on the same root as building it directly", () => {
    const updates: LeafUpdate[] = [
      { leafIndex: 0, value: 11n, present: true },
      { leafIndex: 1, value: 22n, present: true },
      { leafIndex: 2, value: 33n, present: true },
    ];
    const replayed = replayLeafUpdates(CREDENTIAL_TREE_DEPTH, hash, updates);
    const direct = SparseMerkleTree.from(CREDENTIAL_TREE_DEPTH, hash, [
      [0, 11n],
      [1, 22n],
      [2, 33n],
    ]);
    expect(replayed.root()).toBe(direct.root());
  });

  it("replays a revocation, so a removed commitment is gone from the rebuilt tree", () => {
    const replayed = replayLeafUpdates(CREDENTIAL_TREE_DEPTH, hash, [
      { leafIndex: 0, value: 11n, present: true },
      { leafIndex: 1, value: 22n, present: true },
      { leafIndex: 1, value: 22n, present: false },
    ]);
    const direct = SparseMerkleTree.from(CREDENTIAL_TREE_DEPTH, hash, [[0, 11n]]);

    expect(replayed.root()).toBe(direct.root());
    expect(replayed.leafAt(1)).toBeUndefined();
    expect(replayed.leafCount).toBe(1);
  });

  it("depends on the order events are replayed in", () => {
    const inOrder = replayLeafUpdates(CREDENTIAL_TREE_DEPTH, hash, [
      { leafIndex: 3, value: 44n, present: true },
      { leafIndex: 3, value: 44n, present: false },
    ]);
    const reversed = replayLeafUpdates(CREDENTIAL_TREE_DEPTH, hash, [
      { leafIndex: 3, value: 44n, present: false },
      { leafIndex: 3, value: 44n, present: true },
    ]);
    expect(inOrder.root()).not.toBe(reversed.root());
  });

  it("rebuilds a reinstatement back to the root the credential had before", () => {
    const before = SparseMerkleTree.from(CREDENTIAL_TREE_DEPTH, hash, [
      [0, 11n],
      [1, 22n],
    ]);
    const replayed = replayLeafUpdates(CREDENTIAL_TREE_DEPTH, hash, [
      { leafIndex: 0, value: 11n, present: true },
      { leafIndex: 1, value: 22n, present: true },
      { leafIndex: 1, value: 22n, present: false },
      { leafIndex: 1, value: 22n, present: true },
    ]);
    expect(replayed.root()).toBe(before.root());
  });
});
