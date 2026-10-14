pragma circom 2.1.6;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/poseidon.circom";
include "merkle.circom";

/// The four predicates the confidentiality layer must prove for an investor to
/// operate on an asset, none of which reveals who they are, where they live or
/// when their credential runs out:
///
///   1. they hold a credential whose commitment is in the issuer's registry,
///   2. that credential is still valid at the end of the period claimed,
///   3. their jurisdiction belongs to the set the asset admits,
///   4. the nullifier presented derives from that credential, this asset and
///      that period.
///
/// Predicate 2 is compared against `epochEnd`, not against a clock: the circuit
/// has no clock it can trust, and the contract fixes `epochEnd` to a boundary it
/// derives from the block. An attestation therefore cannot outlive the
/// credential behind it, and the expiry never has to be published — publishing
/// it would be the same value on every asset, which is exactly the link the
/// per-asset nullifier exists to break.
///
/// The secret is the investor's, never the issuer's. What the issuer receives is
/// `secretHash = Poseidon(secret)`, and the leaf it publishes is
/// `Poseidon(secretHash, country, expiry)`, so it still fixes the jurisdiction and
/// the expiry the KYC established while holding no preimage. The nullifier keeps
/// deriving from `secret` itself, which is what makes it uncomputable by anyone
/// who only ever saw the hash.
///
/// `anchor` is unconstrained in value on purpose: the contract fixes it to a
/// digest of the subject being attested, the chain and its own address, and the
/// only thing the circuit owes it is to make the proof depend on it, so that a
/// proof seen in the mempool can attest nobody but that subject, nowhere else.
///
/// Revocation is enforced by removing the commitment from the registry: a
/// revoked credential no longer proves predicate 1, and no other investor has
/// to be reissued.
template Compliance(credentialDepth, countryDepth, timestampBits, countryCodeBits) {
    signal input credentialRoot;
    signal input countryRoot;
    signal input assetId;
    signal input epochEnd;
    signal input nullifier;
    signal input anchor;

    signal input secret;
    signal input country;
    signal input expiry;
    signal input credentialPathElements[credentialDepth];
    signal input credentialPathIndices[credentialDepth];
    signal input countryPathElements[countryDepth];
    signal input countryPathIndices[countryDepth];

    // 0 · encodings. GreaterEqThan(n) only orders operands below 2^n: an epochEnd
    // near the field order makes it answer 1 for any expiry.
    component epochEndRange = Num2Bits(timestampBits);
    epochEndRange.in <== epochEnd;

    component expiryRange = Num2Bits(timestampBits);
    expiryRange.in <== expiry;

    // Below 2^countryCodeBits a value cannot be a Poseidon digest, which is what
    // keeps a commitment or an inner node from being replayed as a country leaf.
    component countryRange = Num2Bits(countryCodeBits);
    countryRange.in <== country;

    // 0 is the padding leaf of an unfilled jurisdiction tree, never a country.
    component countryIsPadding = IsZero();
    countryIsPadding.in <== country;
    countryIsPadding.out === 0;

    // 1 · the credential is in the issuer's registry.
    //
    // The commitment binds the hash of the secret, not the secret: the investor
    // hands the issuer `secretHash` and nothing else, so the issuer can build the
    // leaf it has to build without ever holding the preimage the nullifier needs.
    component secretDigest = Poseidon(1);
    secretDigest.inputs[0] <== secret;
    signal secretHash <== secretDigest.out;

    component commitment = Poseidon(3);
    commitment.inputs[0] <== secretHash;
    commitment.inputs[1] <== country;
    commitment.inputs[2] <== expiry;

    component inRegistry = MerkleInclusion(credentialDepth);
    inRegistry.leaf <== commitment.out;
    for (var i = 0; i < credentialDepth; i++) {
        inRegistry.pathElements[i] <== credentialPathElements[i];
        inRegistry.pathIndices[i] <== credentialPathIndices[i];
    }
    inRegistry.root === credentialRoot;

    // 2 · it is still valid when the period claimed ends
    component livePastPeriod = GreaterEqThan(timestampBits);
    livePastPeriod.in[0] <== expiry;
    livePastPeriod.in[1] <== epochEnd;
    livePastPeriod.out === 1;

    // 3 · the jurisdiction is admitted by this asset
    component inAllowed = MerkleInclusion(countryDepth);
    inAllowed.leaf <== country;
    for (var i = 0; i < countryDepth; i++) {
        inAllowed.pathElements[i] <== countryPathElements[i];
        inAllowed.pathIndices[i] <== countryPathIndices[i];
    }
    inAllowed.root === countryRoot;

    // 4 · the nullifier binds this credential to this asset and this period, so a
    // spent attestation can be renewed in the next one without reissuing anything
    component tag = Poseidon(3);
    tag.inputs[0] <== secret;
    tag.inputs[1] <== assetId;
    tag.inputs[2] <== epochEnd;
    tag.out === nullifier;

    // 5 · the proof is bound to whatever the contract puts in `anchor`. A single
    // quadratic constraint is enough to keep the signal in the R1CS, and with it
    // in the R1CS the verifying key commits to its value.
    signal anchorSquared;
    anchorSquared <== anchor * anchor;
}

component main {public [credentialRoot, countryRoot, assetId, epochEnd, nullifier, anchor]} =
    Compliance(20, 8, 64, 16);
