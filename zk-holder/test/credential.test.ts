import { describe, expect, it } from "vitest";

import { credentialCommitment, credentialNullifier, expiryOf } from "../src/credential.js";
import { CREDENTIAL_TREE_DEPTH } from "../src/field.js";
import { rootFromOpening } from "../src/merkle.js";
import { poseidonHash } from "../src/poseidon.js";
import { generateHolderSecret, holderSecretHash } from "../src/secret.js";
import { issuerModules } from "./helpers/issuer.js";

describe("commitment and nullifier", () => {
  it("computes the commitment the issuer publishes for the same verdict", async () => {
    const { material } = await issuerModules();
    const secretHash = await holderSecretHash(generateHolderSecret());
    const expiresAt = "2027-01-31T12:00:00.000Z";
    const expiry = expiryOf(expiresAt);

    const issuer = await material.deriveCommitment(secretHash, 170, BigInt(Math.floor(new Date(expiresAt).getTime() / 1000)));
    expect(await credentialCommitment(secretHash, 170, expiry)).toBe(issuer);
    expect(await credentialCommitment(secretHash, 484, expiry)).not.toBe(issuer);
  });

  it("drops the milliseconds of the expiry the way the issuer does", () => {
    expect(expiryOf("2027-01-31T12:00:00.999Z")).toBe(expiryOf("2027-01-31T12:00:00.000Z"));
  });

  it("derives the nullifier the issuer's reference describes", async () => {
    const { material } = await issuerModules();
    const secret = generateHolderSecret();
    expect(await credentialNullifier(secret, 84532001n, 1796256000n)).toBe(
      await material.deriveNullifier(secret, 84532001n, 1796256000n),
    );
  });

  it("reaches the root of the issuer's tree from the issuer's opening", async () => {
    const { merkle, poseidon } = await issuerModules();
    const hash = await poseidonHash();
    const tree = new merkle.SparseMerkleTree(CREDENTIAL_TREE_DEPTH, await poseidon.poseidonHash());
    const mine = await credentialCommitment(await holderSecretHash(generateHolderSecret()), 170, 1800000000n);
    tree.setLeaf(0, 123n);
    tree.setLeaf(1, mine);
    tree.setLeaf(5, 456n);
    expect(rootFromOpening(hash, mine, tree.opening(1), CREDENTIAL_TREE_DEPTH)).toBe(tree.root());
  });
});
