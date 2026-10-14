pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/mux1.circom";

/// Proves that `leaf` belongs to the tree whose root is the output, without
/// revealing which position it occupies.
template MerkleInclusion(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal levels[depth + 1];
    levels[0] <== leaf;

    component order[depth];
    component hash[depth];

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        order[i] = MultiMux1(2);
        order[i].c[0][0] <== levels[i];
        order[i].c[0][1] <== pathElements[i];
        order[i].c[1][0] <== pathElements[i];
        order[i].c[1][1] <== levels[i];
        order[i].s <== pathIndices[i];

        hash[i] = Poseidon(2);
        hash[i].inputs[0] <== order[i].out[0];
        hash[i].inputs[1] <== order[i].out[1];
        levels[i + 1] <== hash[i].out;
    }

    root <== levels[depth];
}
