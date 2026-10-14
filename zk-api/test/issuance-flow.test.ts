import type { Express } from "express";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/registry.service.js", () => import("./helpers/registry-stub.js"));

import { createApp } from "../src/app.js";
import { CREDENTIAL_TREE_DEPTH, FIELD_ORDER, JURISDICTION_TREE_DEPTH } from "../src/lib/field.js";
import { SparseMerkleTree } from "../src/lib/merkle.js";
import { poseidonHash, type HashFn } from "../src/lib/poseidon.js";
import { prisma } from "../src/lib/prisma.js";
import { createPartner } from "../src/services/partner.service.js";
import {
  activateCredential,
  cancelPendingCredential,
  credentialOpening,
  jurisdictionOpening,
  registerVerification,
  reinstateCredential,
  resolveStatus,
  revokeCredential,
  setAdmittedJurisdictions,
  suspendCredential,
} from "../src/services/issuer.service.js";
import { buildCredentialTree, reconcileCredentialTree } from "../src/services/tree.service.js";
import { resetDatabase } from "./helpers/database.js";
import { activationSignature, holderSecretOf, holderWallet, issueCredentialForHolder } from "./helpers/holder.js";
import { isCredentialRootValid, resetRegistryStub, state } from "./helpers/registry-stub.js";
import { signedRequest } from "./helpers/signed-request.js";

const ASSET = "42";

function verificationFor(subject: string, countryCode: number, expiresInDays = 365) {
  return {
    kycSubjectId: subject,
    holderAddress: holderWallet(subject).address,
    approved: true,
    countryCode,
    expiresAt: new Date(Date.now() + expiresInDays * 24 * 3600 * 1000),
    verificationRef: "VF-2026-000117",
    identity: {
      legalName: `Holder ${subject}`,
      documentType: "CC",
      documentNumber: `DOC-${subject}`,
      countryCode,
    },
  };
}

let server: Express;
let hash: HashFn;

beforeAll(async () => {
  server = createApp();
  hash = await poseidonHash();
});

beforeEach(async () => {
  await resetDatabase();
  resetRegistryStub();
});

describe("issuing a credential in two steps", () => {
  /// Step one commits the bank's verdict and nothing else. There is no leaf to
  /// build: the value at the heart of the commitment belongs to the holder and
  /// has not arrived.
  it("registers the verification without publishing anything", async () => {
    const pending = await registerVerification(verificationFor("subject-a", 170));

    expect(pending.status).toBe("PENDING");
    expect(pending.holderAddress).toBe(holderWallet("subject-a").address);
    expect(state.credentialRoot).toBe(0n);
    expect(await prisma.rootPublication.count()).toBe(0);

    const stored = await prisma.credential.findUniqueOrThrow({ where: { id: pending.credentialId } });
    expect(stored.commitment).toBeNull();
    expect(stored.secretHash).toBeNull();
    expect(stored.leafIndex).toBeNull();
    expect(stored.inTree).toBe(false);
  });

  /// It also hands back the two messages the wallet will be asked to sign, so
  /// the holder's application has no room to invent its own and derive a secret
  /// this issuer's commitments were never built on.
  it("hands back the exact messages the wallet has to sign", async () => {
    const pending = await registerVerification(verificationFor("subject-a", 170));

    expect(pending.activation.secretDerivation.primaryType).toBe("CredentialSecret");
    expect(pending.activation.possession.primaryType).toBe("CredentialActivation");
    expect(pending.activation.secretDerivation.domain.verifyingContract).toBe(
      pending.activation.possession.domain.verifyingContract,
    );
  });

  it("publishes a root that matches the tree built from the leaves once activated", async () => {
    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));

    expect(issued.leafIndex).toBe(0);
    expect(issued.status).toBe("ACTIVE");
    expect(state.credentialRoot.toString()).toBe(issued.credentialRoot);

    const expected = SparseMerkleTree.from(CREDENTIAL_TREE_DEPTH, hash, [[0, BigInt(issued.commitment)]]);
    expect(issued.credentialRoot).toBe(expected.root().toString());
  });

  /// The point of the whole change: what the service ends up holding is the
  /// hash. With it the commitment checks out and no nullifier can be computed.
  it("stores the hash of the secret and never the secret", async () => {
    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));

    const stored = await prisma.credential.findUniqueOrThrow({ where: { commitment: issued.commitment } });
    expect(stored.secretHash).toBe(issued.secretHash.toString());
    expect(JSON.stringify(stored)).not.toContain(issued.secret.toString());
    expect(JSON.stringify(stored)).not.toContain("subject-a");
    expect(stored.subjectRef).toMatch(/^[0-9a-f]{64}$/);
    const { wallet: _wallet, secret, secretHash: _hash, ...response } = issued;
    expect(JSON.stringify(response)).not.toContain(secret.toString());
    expect(Object.keys(response)).not.toContain("secret");
  });

  it("builds the commitment out of the hash the holder supplied", async () => {
    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));
    const stored = await prisma.credential.findUniqueOrThrow({ where: { commitment: issued.commitment } });
    const expiry = BigInt(Math.floor(stored.expiresAt.getTime() / 1000));

    expect(issued.commitment).toBe(hash(issued.secretHash, 170n, expiry).toString());
  });

  it("moves the root on every issuance and keeps the previous one as superseded", async () => {
    const first = await issueCredentialForHolder(verificationFor("subject-a", 170));
    const second = await issueCredentialForHolder(verificationFor("subject-b", 724));

    expect(second.credentialRoot).not.toBe(first.credentialRoot);
    expect(second.leafIndex).toBe(1);
    expect(state.supersededCredentialRoots.has(first.credentialRoot)).toBe(true);
  });
});

describe("proving possession of the wallet at activation", () => {
  /// Without this, the issuer could substitute a hash of its own and the
  /// resulting commitment would be indistinguishable from a legitimate one, and
  /// anyone who learned the pending identifier could get in first.
  it("refuses a hash handed over by a wallet other than the one KYC named", async () => {
    const pending = await registerVerification(verificationFor("subject-a", 170));
    const intruder = holderWallet("intruder");
    const { secretHash } = await holderSecretOf(intruder);
    const signature = await activationSignature(intruder, pending.credentialId, secretHash);

    await expect(
      activateCredential(pending.credentialId, { secretHash: secretHash.toString(), signature }),
    ).rejects.toMatchObject({ output: { payload: { code: "activation_signature_mismatch" } } });

    const stored = await prisma.credential.findUniqueOrThrow({ where: { id: pending.credentialId } });
    expect(stored.status).toBe("PENDING");
    expect(stored.commitment).toBeNull();
  });

  /// The signature covers the hash, so swapping the hash under a genuine
  /// signature does not authenticate either.
  it("refuses a hash swapped under a signature the holder did produce", async () => {
    const pending = await registerVerification(verificationFor("subject-a", 170));
    const wallet = holderWallet("subject-a");
    const { secretHash } = await holderSecretOf(wallet);
    const signature = await activationSignature(wallet, pending.credentialId, secretHash);

    await expect(
      activateCredential(pending.credentialId, { secretHash: (secretHash + 1n).toString(), signature }),
    ).rejects.toMatchObject({ output: { payload: { code: "activation_signature_mismatch" } } });
  });

  it("refuses an activation signed for a different pending credential", async () => {
    const mine = await registerVerification(verificationFor("subject-a", 170));
    const theirs = await registerVerification(verificationFor("subject-b", 724));
    const wallet = holderWallet("subject-a");
    const { secretHash } = await holderSecretOf(wallet);
    const signature = await activationSignature(wallet, theirs.credentialId, secretHash);

    await expect(
      activateCredential(mine.credentialId, { secretHash: secretHash.toString(), signature }),
    ).rejects.toMatchObject({ output: { payload: { code: "activation_signature_mismatch" } } });
  });

  it("refuses a signature that is not a signature at all", async () => {
    const pending = await registerVerification(verificationFor("subject-a", 170));
    const { secretHash } = await holderSecretOf(holderWallet("subject-a"));

    await expect(
      activateCredential(pending.credentialId, {
        secretHash: secretHash.toString(),
        signature: `0x${"00".repeat(65)}`,
      }),
    ).rejects.toMatchObject({ output: { payload: { code: "activation_signature_malformed" } } });
  });

  /// A contract account has no signature of its own to reproduce: ERC-1271
  /// validates on behalf of a signer the account can change, so a secret derived
  /// from one stops being derivable the day the signer rotates.
  it("refuses a holder address that carries code", async () => {
    const wallet = holderWallet("subject-a");
    state.contractAccounts.add(wallet.address.toLowerCase());

    const pending = await registerVerification(verificationFor("subject-a", 170));
    const { secretHash } = await holderSecretOf(wallet);
    const signature = await activationSignature(wallet, pending.credentialId, secretHash);

    await expect(
      activateCredential(pending.credentialId, { secretHash: secretHash.toString(), signature }),
    ).rejects.toMatchObject({ output: { payload: { code: "holder_is_contract_account" } } });
  });

  it("refuses a hash that is not a field element", async () => {
    const pending = await registerVerification(verificationFor("subject-a", 170));
    const wallet = holderWallet("subject-a");

    for (const bad of ["0", FIELD_ORDER.toString()]) {
      const signature = await activationSignature(wallet, pending.credentialId, BigInt(bad));
      await expect(
        activateCredential(pending.credentialId, { secretHash: bad, signature }),
      ).rejects.toMatchObject({ output: { payload: { code: "secret_hash_invalid" } } });
    }
  });

  it("refuses to activate the same credential twice", async () => {
    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));
    const wallet = holderWallet("subject-a");
    const signature = await activationSignature(wallet, issued.credentialId, issued.secretHash);

    await expect(
      activateCredential(issued.credentialId, { secretHash: issued.secretHash.toString(), signature }),
    ).rejects.toMatchObject({ output: { payload: { code: "credential_not_pending" } } });
  });
});

describe("one live credential per subject, and one credential per wallet", () => {
  it("refuses a second credential while the first is still pending", async () => {
    await registerVerification(verificationFor("subject-a", 170));
    await expect(registerVerification(verificationFor("subject-a", 170))).rejects.toMatchObject({
      output: { payload: { code: "credential_already_issued" } },
    });
  });

  it("refuses a second credential for the same subject", async () => {
    await issueCredentialForHolder(verificationFor("subject-a", 170));
    await expect(registerVerification(verificationFor("subject-a", 170))).rejects.toMatchObject({
      output: { payload: { code: "credential_already_issued" } },
    });
  });

  /// The Sybil control now lives here rather than in the derivation, so it has
  /// to hold when the second enrolment declares another jurisdiction: it is the
  /// subject that collides, not the country.
  it("refuses a second credential for the same subject under a different jurisdiction", async () => {
    await issueCredentialForHolder(verificationFor("subject-a", 170));
    await expect(registerVerification(verificationFor("subject-a", 724))).rejects.toMatchObject({
      output: { payload: { code: "credential_already_issued" } },
    });
    expect(await prisma.credential.count()).toBe(1);
  });

  it("refuses a second credential while the first is only suspended", async () => {
    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));
    await suspendCredential(issued.commitment);

    await expect(registerVerification(verificationFor("subject-a", 170))).rejects.toMatchObject({
      output: { payload: { code: "credential_already_issued" } },
    });
  });

  /// Nobody can rescue a holder who loses their wallet -- not even the issuer,
  /// which is the price of the change. Revoking and issuing again after a fresh
  /// identity check is the only way back, so a revoked credential must stop
  /// blocking the subject.
  it("lets the same subject be issued again once the first is revoked", async () => {
    const first = await issueCredentialForHolder(verificationFor("subject-a", 170));
    await revokeCredential(first.commitment);

    const replacement = await issueCredentialForHolder(
      verificationFor("subject-a", 170),
      holderWallet("subject-a-new-wallet"),
    );

    expect(replacement.commitment).not.toBe(first.commitment);
    expect(replacement.leafIndex).toBe(1);
    expect(state.credentialRoot.toString()).toBe(replacement.credentialRoot);
  });

  /// Two KYC identifiers, one wallet. Cheap to catch, and it says nothing about
  /// the same person using two wallets -- that is the KYC provider's job.
  it("refuses a second credential standing behind the same wallet secret", async () => {
    const wallet = holderWallet("shared-wallet");
    await issueCredentialForHolder(verificationFor("subject-a", 170), wallet);

    const pending = await registerVerification({ ...verificationFor("subject-b", 170), holderAddress: wallet.address });
    const { secretHash } = await holderSecretOf(wallet);
    const signature = await activationSignature(wallet, pending.credentialId, secretHash);

    await expect(
      activateCredential(pending.credentialId, { secretHash: secretHash.toString(), signature }),
    ).rejects.toMatchObject({ output: { payload: { code: "secret_hash_already_used" } } });
  });

  /// The rule is the database's, not just the service's: a bug in the code path
  /// that checks first cannot open a second live credential.
  it("is refused by the database itself, not only by the code that checks", async () => {
    const first = await registerVerification(verificationFor("subject-a", 170));
    const stored = await prisma.credential.findUniqueOrThrow({ where: { id: first.credentialId } });

    const duplicate = {
      subjectRef: stored.subjectRef,
      holderAddress: holderWallet("another-wallet").address.toLowerCase(),
      countryCode: 170,
      expiresAt: stored.expiresAt,
      verificationRef: "VF-duplicate",
    };
    await expect(prisma.credential.create({ data: duplicate })).rejects.toThrow(/Unique constraint/);

    await cancelPendingCredential(first.credentialId);
    await expect(prisma.credential.create({ data: duplicate })).resolves.toMatchObject({ status: "PENDING" });
  });

  it("frees the subject when an abandoned enrolment is cancelled", async () => {
    const abandoned = await registerVerification(verificationFor("subject-a", 170));
    expect(await cancelPendingCredential(abandoned.credentialId)).toMatchObject({ status: "REVOKED" });

    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));
    expect(issued.status).toBe("ACTIVE");
  });

  it("refuses to cancel a credential that was already activated", async () => {
    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));
    await expect(cancelPendingCredential(issued.credentialId)).rejects.toMatchObject({
      output: { payload: { code: "credential_not_pending" } },
    });
  });
});

describe("what the issuer refuses outright", () => {
  it("refuses a verification that was not approved", async () => {
    await expect(
      registerVerification({ ...verificationFor("subject-a", 170), approved: false }),
    ).rejects.toMatchObject({ output: { payload: { code: "verification_not_approved" } } });
    expect(await prisma.credential.count()).toBe(0);
  });

  it("refuses a country code outside what the circuit encodes", async () => {
    await expect(registerVerification(verificationFor("subject-a", 65_536))).rejects.toMatchObject({
      output: { payload: { code: "country_code_out_of_range" } },
    });
  });

  it("refuses a holder address that is not an address", async () => {
    await expect(
      registerVerification({ ...verificationFor("subject-a", 170), holderAddress: "not-an-address" }),
    ).rejects.toMatchObject({ output: { payload: { code: "holder_address_invalid" } } });
  });

  it("refuses to activate a verification that ran out while it waited", async () => {
    const pending = await registerVerification(verificationFor("subject-a", 170, 1));
    await prisma.credential.update({
      where: { id: pending.credentialId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const wallet = holderWallet("subject-a");
    const { secretHash } = await holderSecretOf(wallet);
    const signature = await activationSignature(wallet, pending.credentialId, secretHash);

    await expect(
      activateCredential(pending.credentialId, { secretHash: secretHash.toString(), signature }),
    ).rejects.toMatchObject({ output: { payload: { code: "credential_expired" } } });
  });

  /// The chain write sits inside the transaction, so a registry that refuses the
  /// root leaves no row claiming a leaf position nobody published.
  it("rolls the activation back when the registry refuses the root", async () => {
    const pending = await registerVerification(verificationFor("subject-a", 170));
    const wallet = holderWallet("subject-a");
    const { secretHash } = await holderSecretOf(wallet);
    const signature = await activationSignature(wallet, pending.credentialId, secretHash);

    state.failNextPublication = true;
    await expect(
      activateCredential(pending.credentialId, { secretHash: secretHash.toString(), signature }),
    ).rejects.toThrow();

    const stored = await prisma.credential.findUniqueOrThrow({ where: { id: pending.credentialId } });
    expect(stored.status).toBe("PENDING");
    expect(stored.commitment).toBeNull();
    expect(stored.leafIndex).toBeNull();
    expect(state.credentialRoot).toBe(0n);
  });

  it("gives an opening that recomputes the published root", async () => {
    await issueCredentialForHolder(verificationFor("subject-a", 170));
    const issued = await issueCredentialForHolder(verificationFor("subject-b", 724));

    const opening = await credentialOpening(issued.commitment);
    const tree = await buildCredentialTree();

    expect(opening.credentialRoot).toBe(state.credentialRoot.toString());
    expect(tree.verifyOpening(BigInt(issued.commitment), opening.opening)).toBe(state.credentialRoot);
  });
});

describe("revoking a credential", () => {
  it("takes the leaf out and publishes a root without it", async () => {
    const first = await issueCredentialForHolder(verificationFor("subject-a", 170));
    const second = await issueCredentialForHolder(verificationFor("subject-b", 724));

    const revocation = await revokeCredential(second.commitment);

    expect(revocation.previousRoot).toBe(second.credentialRoot);
    expect(revocation.credentialRoot).toBe(first.credentialRoot);
    expect(state.credentialRoot.toString()).toBe(first.credentialRoot);
  });

  it("leaves every other holder's credential provable", async () => {
    const alice = await issueCredentialForHolder(verificationFor("subject-a", 170));
    const bob = await issueCredentialForHolder(verificationFor("subject-b", 724));

    await revokeCredential(bob.commitment);

    const opening = await credentialOpening(alice.commitment);
    const tree = await buildCredentialTree();
    expect(tree.verifyOpening(BigInt(alice.commitment), opening.opening)).toBe(state.credentialRoot);
  });

  it("stops producing an opening for the revoked commitment", async () => {
    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));
    await revokeCredential(issued.commitment);

    await expect(credentialOpening(issued.commitment)).rejects.toMatchObject({
      output: { payload: { code: "credential_not_in_tree" } },
    });
  });

  it("refuses to revoke twice", async () => {
    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));
    await revokeCredential(issued.commitment);
    await expect(revokeCredential(issued.commitment)).rejects.toMatchObject({
      output: { payload: { code: "credential_not_in_tree" } },
    });
  });

  /// Removing the leaf is not yet immediate: the superseded root stays
  /// acceptable for the registry's window, and against it the revoked commitment
  /// still proves membership. Closing the window is what makes it immediate.
  it("closes the superseded root's window by default", async () => {
    const first = await issueCredentialForHolder(verificationFor("subject-a", 170));
    const second = await issueCredentialForHolder(verificationFor("subject-b", 724));

    const revocation = await revokeCredential(second.commitment);

    expect(revocation.previousRootInvalidated).toBe(true);
    expect(state.supersededCredentialRoots.has(second.credentialRoot)).toBe(false);
    expect(await isCredentialRootValid(BigInt(second.credentialRoot))).toBe(false);
    expect(await isCredentialRootValid(BigInt(first.credentialRoot))).toBe(true);
  });

  it("leaves the window open when the operator asks it to", async () => {
    await issueCredentialForHolder(verificationFor("subject-a", 170));
    const second = await issueCredentialForHolder(verificationFor("subject-b", 724));

    const revocation = await revokeCredential(second.commitment, false);

    expect(revocation.previousRootInvalidated).toBe(false);
    expect(await isCredentialRootValid(BigInt(second.credentialRoot))).toBe(true);
  });

  it("does not free the leaf position for the next issuance", async () => {
    const first = await issueCredentialForHolder(verificationFor("subject-a", 170));
    await revokeCredential(first.commitment);
    const second = await issueCredentialForHolder(verificationFor("subject-b", 724));
    expect(second.leafIndex).toBe(1);
  });
});

describe("suspending and reinstating", () => {
  it("suspension removes the leaf, reinstatement puts the same root back", async () => {
    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));
    const rootWithLeaf = issued.credentialRoot;

    const suspension = await suspendCredential(issued.commitment);
    expect(suspension.status).toBe("SUSPENDED");
    expect(suspension.credentialRoot).not.toBe(rootWithLeaf);

    const reinstatement = await reinstateCredential(issued.commitment);
    expect(reinstatement.status).toBe("ACTIVE");
    expect(reinstatement.credentialRoot).toBe(rootWithLeaf);
  });

  it("refuses to reinstate a credential that was revoked, not suspended", async () => {
    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));
    await revokeCredential(issued.commitment);
    await expect(reinstateCredential(issued.commitment)).rejects.toMatchObject({
      output: { payload: { code: "credential_not_suspended" } },
    });
  });

  it("reads an expired credential as expired whatever its stored status", () => {
    const expired = { status: "ACTIVE" as const, expiresAt: new Date(Date.now() - 1000) };
    expect(resolveStatus(expired)).toBe("EXPIRED");

    const suspendedAndExpired = { status: "SUSPENDED" as const, expiresAt: new Date(Date.now() - 1000) };
    expect(resolveStatus(suspendedAndExpired)).toBe("EXPIRED");

    const revokedAndExpired = { status: "REVOKED" as const, expiresAt: new Date(Date.now() - 1000) };
    expect(resolveStatus(revokedAndExpired)).toBe("REVOKED");
  });
});

describe("admitted jurisdictions", () => {
  it("publishes a country root that matches the tree of admitted codes", async () => {
    const update = await setAdmittedJurisdictions(ASSET, [724, 250]);
    const expected = SparseMerkleTree.from(JURISDICTION_TREE_DEPTH, hash, [
      [0, 724n],
      [1, 250n],
    ]);

    expect(update.countryRoot).toBe(expected.root().toString());
    expect(state.countryRoots.get(ASSET)?.toString()).toBe(update.countryRoot);
  });

  it("keeps a country that stays admitted at the same leaf position", async () => {
    await setAdmittedJurisdictions(ASSET, [724, 250]);
    const before = await jurisdictionOpening(ASSET, 724);

    await setAdmittedJurisdictions(ASSET, [724, 840]);
    const after = await jurisdictionOpening(ASSET, 724);

    expect(after.leafIndex).toBe(before.leafIndex);
  });

  it("stops giving an opening for a country that was withdrawn", async () => {
    await setAdmittedJurisdictions(ASSET, [724, 250]);
    await setAdmittedJurisdictions(ASSET, [724]);

    await expect(jurisdictionOpening(ASSET, 250)).rejects.toMatchObject({
      output: { payload: { code: "jurisdiction_not_admitted" } },
    });
  });

  it("refuses an update that would leave the root unchanged", async () => {
    await setAdmittedJurisdictions(ASSET, [724, 250]);
    await expect(setAdmittedJurisdictions(ASSET, [250, 724])).rejects.toMatchObject({
      output: { payload: { code: "jurisdiction_set_unchanged" } },
    });
  });

  it("gives an opening that recomputes the published country root", async () => {
    await setAdmittedJurisdictions(ASSET, [724, 250, 840]);
    const opening = await jurisdictionOpening(ASSET, 250);
    const tree = SparseMerkleTree.from(JURISDICTION_TREE_DEPTH, hash, [
      [0, 724n],
      [1, 250n],
      [2, 840n],
    ]);
    expect(tree.verifyOpening(250n, opening.opening)).toBe(BigInt(opening.countryRoot));
  });
});

describe("rebuilding the issuer's state from the registry's events", () => {
  it("replays issuance and revocation back to the root the registry holds", async () => {
    await issueCredentialForHolder(verificationFor("subject-a", 170));
    const bob = await issueCredentialForHolder(verificationFor("subject-b", 724));
    await issueCredentialForHolder(verificationFor("subject-c", 250));
    await revokeCredential(bob.commitment);

    const report = await reconcileCredentialTree();

    expect(report).toMatchObject({
      source: "chain-events",
      events: 4,
      leafCount: 2,
      matchesChain: true,
      missingFromDatabase: [],
      missingFromChain: [],
    });
    expect(report.replayedRoot).toBe(state.credentialRoot.toString());
  });

  it("rebuilds the same tree after the database is thrown away", async () => {
    await issueCredentialForHolder(verificationFor("subject-a", 170));
    await issueCredentialForHolder(verificationFor("subject-b", 724));
    const rootBefore = state.credentialRoot;

    await prisma.credential.deleteMany();

    const report = await reconcileCredentialTree();
    expect(report.replayedRoot).toBe(rootBefore.toString());
    expect(report.matchesChain).toBe(true);
    expect(report.missingFromDatabase).toHaveLength(2);
  });

  it("names a disagreement instead of quietly repairing it", async () => {
    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));
    await prisma.credential.create({
      data: {
        commitment: "999999999999999999",
        subjectRef: "ff".repeat(32),
        holderAddress: holderWallet("ghost").address.toLowerCase(),
        leafIndex: 5,
        countryCode: 170,
        expiresAt: new Date(Date.now() + 86_400_000),
        status: "ACTIVE",
        inTree: true,
        verificationRef: "VF-ghost",
      },
    });

    const report = await reconcileCredentialTree();
    expect(report.missingFromChain).toEqual(["999999999999999999"]);
    expect(report.missingFromDatabase).toEqual([]);
    expect(report.replayedRoot).toBe(issued.credentialRoot);
  });
});

describe("the issuance routes", () => {
  it("registers and then activates over HTTP, each under its own scope", async () => {
    const desk = await createPartner("issuing-desk", ["credentials:issue", "credentials:read"]);
    const app = await createPartner("holder-app", ["credentials:activate"]);
    const wallet = holderWallet("subject-http");

    const registered = await signedRequest(server, {
      method: "post",
      path: "/v1/credentials",
      partnerKey: desk.partnerKey,
      secret: desk.secret,
      body: {
        kycSubjectId: "subject-http",
        holderAddress: wallet.address,
        verification: {
          approved: true,
          countryCode: 170,
          expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
          reference: "VF-http",
        },
        identity: { legalName: "Holder", documentType: "CC", documentNumber: "1", countryCode: 170 },
      },
    });

    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({ status: "PENDING" });
    expect(registered.body.commitment).toBeUndefined();
    expect(state.credentialRoot).toBe(0n);

    const { secretHash } = await holderSecretOf(wallet);
    const activated = await signedRequest(server, {
      method: "post",
      path: `/v1/credentials/${registered.body.credentialId}/activation`,
      partnerKey: app.partnerKey,
      secret: app.secret,
      body: {
        secretHash: secretHash.toString(),
        signature: await activationSignature(wallet, registered.body.credentialId, secretHash),
      },
    });

    expect(activated.status).toBe(201);
    expect(activated.body).toMatchObject({ leafIndex: 0, status: "ACTIVE" });
    expect(activated.body.credentialRoot).toBe(state.credentialRoot.toString());
  });

  /// The desk that registers the verification must not be able to complete the
  /// credential on the holder's behalf.
  it("refuses activation from a partner that only holds the issuing scope", async () => {
    const desk = await createPartner("issuing-desk", ["credentials:issue"]);
    const wallet = holderWallet("subject-http");
    const pending = await registerVerification({
      ...verificationFor("subject-http", 170),
      holderAddress: wallet.address,
    });
    const { secretHash } = await holderSecretOf(wallet);

    const response = await signedRequest(server, {
      method: "post",
      path: `/v1/credentials/${pending.credentialId}/activation`,
      partnerKey: desk.partnerKey,
      secret: desk.secret,
      body: {
        secretHash: secretHash.toString(),
        signature: await activationSignature(wallet, pending.credentialId, secretHash),
      },
    });

    expect(response.status).toBe(403);
  });

  it("refuses a payload that does not match the contract", async () => {
    const desk = await createPartner("issuing-desk", ["credentials:issue"]);

    const response = await signedRequest(server, {
      method: "post",
      path: "/v1/credentials",
      partnerKey: desk.partnerKey,
      secret: desk.secret,
      body: { kycSubjectId: "subject-http", verification: { approved: true, countryCode: 0 } },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("validation_failed");
  });
});

/// The platform that builds proofs for the holder reads openings and nothing else,
/// and the administrator who rebuilds state does not read openings by default.
describe("the opening routes", () => {
  async function seeded() {
    const issued = await issueCredentialForHolder(verificationFor("subject-a", 170));
    await setAdmittedJurisdictions(ASSET, [170, 724]);
    return issued;
  }

  it("serves both openings to a partner holding credentials:opening", async () => {
    const issued = await seeded();
    const platform = await createPartner("holder-platform", ["credentials:opening"]);

    const credential = await signedRequest(server, {
      method: "get",
      path: `/v1/credentials/${issued.commitment}/opening`,
      partnerKey: platform.partnerKey,
      secret: platform.secret,
    });
    const jurisdiction = await signedRequest(server, {
      method: "get",
      path: `/v1/assets/${ASSET}/jurisdictions/170/opening`,
      partnerKey: platform.partnerKey,
      secret: platform.secret,
    });

    expect(credential.status).toBe(200);
    expect(credential.body.credentialRoot).toBe(state.credentialRoot.toString());
    expect(jurisdiction.status).toBe(200);
    expect(jurisdiction.body.countryRoot).toBe(state.countryRoots.get(ASSET)?.toString());
  });

  it("does not serve an opening on issuer:admin alone", async () => {
    const issued = await seeded();
    const admin = await createPartner("operator", ["issuer:admin"]);

    for (const path of [`/v1/credentials/${issued.commitment}/opening`, `/v1/assets/${ASSET}/jurisdictions/170/opening`]) {
      const response = await signedRequest(server, { method: "get", path, partnerKey: admin.partnerKey, secret: admin.secret });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "insufficient_scope", details: { required: "credentials:opening" } });
    }
  });

  it("gives the opening scope nothing an administrator can do", async () => {
    await seeded();
    const platform = await createPartner("holder-platform", ["credentials:opening"]);

    for (const path of ["/v1/issuer/state/rebuild", `/v1/issuer/assets/${ASSET}/state/rebuild`]) {
      const response = await signedRequest(server, { method: "post", path, partnerKey: platform.partnerKey, secret: platform.secret });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("insufficient_scope");
    }
  });
});
