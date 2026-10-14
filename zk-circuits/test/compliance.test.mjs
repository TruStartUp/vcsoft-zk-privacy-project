import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import {
  COUNTRY_CODE_BITS,
  COUNTRY_DEPTH,
  CREDENTIAL_DEPTH,
  FIELD_ORDER,
  TIMESTAMP_BITS,
  accepted,
  constraintsTouching,
  hash,
  merkleTree,
  rejectedAt,
  releaseCurveWorkers,
  witnessIndexOf,
} from "./helpers.mjs";

const SECRET = 0x5eec12eb0ff1ce5eec12eb0ff1cen;
const COUNTRY = 604n;
const ASSET = 42n;
const EPOCH_LENGTH = 2592000n;
const EPOCH_END = 1902528000n;
const NEXT_EPOCH_END = EPOCH_END + EPOCH_LENGTH;
const EXPIRY = EPOCH_END + 31536000n;
const ANCHOR = 0x9c0f5e2d1b3a47869c0f5e2d1b3a4786n;

/// The issuer only ever sees Poseidon(secret), so every leaf is built from the
/// digest and never from the preimage the nullifier needs.
const secretHashOf = (secret) => hash(secret);
const commitmentOf = (secret, country = COUNTRY, expiry = EXPIRY) =>
  hash(secretHashOf(secret), country, expiry);

const OTHER_INVESTORS = [11n, 22n, 33n, 44n, 55n, 66n, 77n].map((s) => commitmentOf(s));
const REGISTRY_INDEX = 5;
const ALLOWED = [32n, 76n, 152n, 170n, 218n, 604n, 724n, 840n];

after(releaseCurveWorkers);

function scenario({
  secret = SECRET,
  country = COUNTRY,
  expiry = EXPIRY,
  asset = ASSET,
  epochEnd = EPOCH_END,
  anchor = ANCHOR,
  registryLeaf,
  registryIndex = REGISTRY_INDEX,
  allowed = ALLOWED,
  countryIndex,
} = {}) {
  const leaves = [...OTHER_INVESTORS];
  leaves[registryIndex] = registryLeaf ?? commitmentOf(secret, country, expiry);
  const registry = merkleTree(leaves, CREDENTIAL_DEPTH);
  const inRegistry = registry.proof(registryIndex);

  const jurisdictions = merkleTree(allowed, COUNTRY_DEPTH);
  const inAllowed = jurisdictions.proof(countryIndex ?? Math.max(allowed.indexOf(country), 0));

  return {
    credentialRoot: registry.root,
    countryRoot: jurisdictions.root,
    assetId: asset,
    epochEnd,
    nullifier: hash(secret, asset, epochEnd),
    anchor,
    secret,
    country,
    expiry,
    credentialPathElements: inRegistry.pathElements,
    credentialPathIndices: inRegistry.pathIndices,
    countryPathElements: inAllowed.pathElements,
    countryPathIndices: inAllowed.pathIndices,
  };
}

const IN_REGISTRY = "inRegistry.root === credentialRoot";
const LIVE_PAST_PERIOD = "livePastPeriod.out === 1";
const IN_ALLOWED = "inAllowed.root === countryRoot";
const NULLIFIER = "tag.out === nullifier";
const EPOCH_END_RANGE = "epochEndRange.in <== epochEnd";
const EXPIRY_RANGE = "expiryRange.in <== expiry";
const COUNTRY_RANGE = "countryRange.in <== country";
const COUNTRY_NOT_PADDING = "countryIsPadding.out === 0";
const REGISTRY_INDEX_BIT = "inRegistry.pathIndices[i] <== credentialPathIndices[i]";
const COUNTRY_INDEX_BIT = "inAllowed.pathIndices[i] <== countryPathIndices[i]";

describe("happy path", () => {
  test("a live credential from an admitted jurisdiction satisfies the four predicates", async () => {
    await accepted(scenario());
  });

  test("the position of the credential in the registry does not matter", async () => {
    for (const registryIndex of [0, 3, 6]) await accepted(scenario({ registryIndex }));
  });

  test("a credential running out exactly at the end of the period is still live", async () => {
    await accepted(scenario({ expiry: EPOCH_END }));
  });

  test("any anchor is admissible, its value is the contract's to impose", async () => {
    for (const anchor of [0n, 1n, FIELD_ORDER - 1n]) await accepted(scenario({ anchor }));
  });
});

describe("the secret is the holder's and the issuer only ever sees its hash", () => {
  test("the leaf the circuit recomputes is Poseidon(Poseidon(secret), country, expiry)", async () => {
    await accepted(scenario({ registryLeaf: hash(hash(SECRET), COUNTRY, EXPIRY) }));
  });

  test("a leaf built on the raw secret, as the issuer used to build it, no longer proves membership", async () => {
    await rejectedAt(scenario({ registryLeaf: hash(SECRET, COUNTRY, EXPIRY) }), IN_REGISTRY);
  });

  test("holding the hash instead of the secret does not let anyone stand in for the holder", async () => {
    const input = scenario();
    input.secret = secretHashOf(SECRET);
    input.nullifier = hash(input.secret, ASSET, EPOCH_END);
    await rejectedAt(input, IN_REGISTRY);
  });

  /// What the issuer keeps is the digest, and the nullifier is a function of the
  /// preimage: the tag it could compute out of its own records is not the tag the
  /// circuit demands.
  test("the nullifier the issuer could compute from what it holds is not the one the circuit accepts", async () => {
    const input = scenario();
    input.nullifier = hash(secretHashOf(SECRET), ASSET, EPOCH_END);
    await rejectedAt(input, NULLIFIER);
  });
});

describe("each predicate rejected on its own", () => {
  test("the commitment is not in the issuer's registry (revocation)", async () => {
    await rejectedAt(scenario({ registryLeaf: commitmentOf(999n) }), IN_REGISTRY);
  });

  test("the credential runs out one second before the period ends", async () => {
    await rejectedAt(scenario({ expiry: EPOCH_END - 1n }), LIVE_PAST_PERIOD);
  });

  test("the jurisdiction is not admitted by the asset", async () => {
    await rejectedAt(scenario({ country: 250n }), IN_ALLOWED);
  });

  test("the nullifier does not derive from the credential", async () => {
    const input = scenario();
    input.nullifier = hash(SECRET, ASSET, EPOCH_END) + 1n;
    await rejectedAt(input, NULLIFIER);
  });
});

describe("an attestation cannot outlive the credential behind it", () => {
  test("a credential that only reaches this period cannot claim the next one", async () => {
    await accepted(scenario({ expiry: EPOCH_END }));
    await rejectedAt(scenario({ expiry: EPOCH_END, epochEnd: NEXT_EPOCH_END }), LIVE_PAST_PERIOD);
  });

  test("a credential that ran out long ago proves nothing at all", async () => {
    await rejectedAt(scenario({ expiry: 1n }), LIVE_PAST_PERIOD);
  });
});

describe("the nullifier is per credential, asset and period", () => {
  test("the same credential, asset and period always give the same nullifier", async () => {
    const first = await accepted(scenario());
    const second = await accepted(scenario());
    assert.deepEqual(first, second);
    assert.equal(scenario().nullifier, hash(SECRET, ASSET, EPOCH_END));
  });

  test("different assets give different nullifiers", async () => {
    const other = 43n;
    assert.notEqual(hash(SECRET, ASSET, EPOCH_END), hash(SECRET, other, EPOCH_END));
    await accepted(scenario({ asset: other }));
  });

  test("the next period renews the same credential with a fresh nullifier", async () => {
    assert.notEqual(hash(SECRET, ASSET, EPOCH_END), hash(SECRET, ASSET, NEXT_EPOCH_END));
    await accepted(scenario({ epochEnd: NEXT_EPOCH_END }));
  });

  test("a nullifier minted for another period does not pass for this one", async () => {
    const input = scenario();
    input.nullifier = hash(SECRET, ASSET, NEXT_EPOCH_END);
    await rejectedAt(input, NULLIFIER);
  });

  test("a nullifier minted for another asset does not pass for this one", async () => {
    const input = scenario();
    input.nullifier = hash(SECRET, 43n, EPOCH_END);
    await rejectedAt(input, NULLIFIER);
  });

  test("different credentials give different nullifiers for the same asset and period", async () => {
    assert.notEqual(hash(SECRET, ASSET, EPOCH_END), hash(SECRET + 1n, ASSET, EPOCH_END));
  });
});

describe("the anchor is part of the constraint system", () => {
  test("the compiler keeps the signal instead of folding it away", async () => {
    const index = witnessIndexOf("main.anchor");
    assert.ok(index >= 0, "the anchor was folded out of the witness");

    const hits = await constraintsTouching(index);
    assert.ok(hits.length > 0, "the anchor appears in no constraint, so the proof cannot bind it");
  });

  test("it sits on both sides of a quadratic constraint, never as a dangling input", async () => {
    const hits = await constraintsTouching(witnessIndexOf("main.anchor"));
    const quadratic = hits.filter((hit) => hit.in.includes("A") && hit.in.includes("B"));
    assert.ok(
      quadratic.length > 0,
      `the anchor only appears at ${JSON.stringify(hits)}; a signal outside every product term ` +
        "gets an identity point in the verifying key and the verifier ignores its value",
    );
  });

  test("changing the anchor changes the witness", async () => {
    const honest = await accepted(scenario());
    const elsewhere = await accepted(scenario({ anchor: ANCHOR + 1n }));
    assert.notDeepEqual(honest, elsewhere);
  });
});

describe("forged Merkle openings", () => {
  test("a tampered sibling in the registry path", async () => {
    const input = scenario();
    input.credentialPathElements[7] = 12345n;
    await rejectedAt(input, IN_REGISTRY);
  });

  test("a tampered sibling in the jurisdiction path", async () => {
    const input = scenario();
    input.countryPathElements[2] = 12345n;
    await rejectedAt(input, IN_ALLOWED);
  });

  test("a registry path index outside {0, 1}", async () => {
    const input = scenario();
    input.credentialPathIndices[0] = 2n;
    await rejectedAt(input, REGISTRY_INDEX_BIT);
  });

  test("a jurisdiction path index outside {0, 1}", async () => {
    const input = scenario();
    input.countryPathIndices[1] = 7n;
    await rejectedAt(input, COUNTRY_INDEX_BIT);
  });

  test("a path index of -1, which is not a bit either", async () => {
    const input = scenario();
    input.credentialPathIndices[4] = FIELD_ORDER - 1n;
    await rejectedAt(input, REGISTRY_INDEX_BIT);
  });
});

describe("out of range operands", () => {
  test("an expiry above 2^" + TIMESTAMP_BITS, async () => {
    await rejectedAt(scenario({ expiry: 2n ** BigInt(TIMESTAMP_BITS) }), EXPIRY_RANGE);
  });

  test("an expiry supplied as -1, which the field reads as p-1", async () => {
    await rejectedAt(scenario({ expiry: -1n }), EXPIRY_RANGE);
  });

  test("a period end near the field order no longer defeats the comparator", async () => {
    await rejectedAt(scenario({ expiry: 1n, epochEnd: FIELD_ORDER - 1n }), EPOCH_END_RANGE);
  });

  test("a country code above 2^" + COUNTRY_CODE_BITS, async () => {
    await rejectedAt(scenario({ country: 2n ** BigInt(COUNTRY_CODE_BITS) }), COUNTRY_RANGE);
  });
});

describe("domain separation between the two trees", () => {
  test("a credential commitment cannot be replayed as a jurisdiction leaf", async () => {
    const foreignLeaf = hash(1n, 2n, 3n);
    const allowed = [...ALLOWED.slice(0, 4), foreignLeaf];
    await rejectedAt(scenario({ country: foreignLeaf, allowed }), COUNTRY_RANGE);
  });

  test("an inner node of the jurisdiction tree cannot be replayed as a leaf", async () => {
    const innerNode = hash(ALLOWED[0], ALLOWED[1]);
    const allowed = [...ALLOWED, innerNode];
    await rejectedAt(scenario({ country: innerNode, allowed }), COUNTRY_RANGE);
  });

  test("the padding leaf of an unfilled jurisdiction tree is not a country", async () => {
    const input = scenario({ country: 0n, allowed: [76n, 152n], countryIndex: 2 });
    const padding = merkleTree([76n, 152n], COUNTRY_DEPTH);
    assert.equal(input.countryRoot, padding.root);
    await rejectedAt(input, COUNTRY_NOT_PADDING);
  });

  test("a country that is in the tree but not the one inside the credential", async () => {
    const credential = scenario();
    const elsewhere = scenario({ country: 840n });
    const input = {
      ...credential,
      country: 840n,
      countryPathElements: elsewhere.countryPathElements,
      countryPathIndices: elsewhere.countryPathIndices,
    };
    await rejectedAt(input, IN_REGISTRY);
  });
});

describe("field aliasing", () => {
  test("operands congruent modulo the field order are the same operand", async () => {
    const honest = await accepted(scenario());
    const aliased = await accepted(scenario({ expiry: EXPIRY + FIELD_ORDER }));
    assert.deepEqual(honest, aliased);
  });

  test("a secret congruent modulo the field order keeps the same nullifier", async () => {
    assert.equal(hash(SECRET, ASSET, EPOCH_END), hash(SECRET + FIELD_ORDER, ASSET, EPOCH_END));
  });

  test("a period end congruent modulo the field order is the same period", async () => {
    const honest = await accepted(scenario());
    const aliased = await accepted(scenario({ epochEnd: EPOCH_END + FIELD_ORDER }));
    assert.deepEqual(honest, aliased);
  });
});
