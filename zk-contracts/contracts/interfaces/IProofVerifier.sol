// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/// The boundary the proving scheme lives behind.
///
/// The proof is opaque bytes: nothing above this interface knows whether it holds three
/// elliptic curve points or twenty-four field elements, and nothing above it has to
/// change when that answer changes. The six public signals are passed apart, in the
/// order the circuit declares them, because they are the only part of a proof the rest
/// of the system reasons about.
///
/// Implementations are adapters over the verifier snarkjs generates, which is left
/// untouched. Two obligations make them interchangeable rather than merely similar:
///
/// 1. `verifyCompliance` answers `false` for anything it cannot accept -- a malformed
///    proof body, a public signal outside the scalar field, a failed pairing -- and
///    never reverts on caller-supplied data.
/// 2. Every public signal is rejected unless it is a canonical field element. The
///    Groth16 verifier snarkjs emits does this itself; the PLONK one does not, and its
///    adapter has to close the gap, or swapping the scheme would silently swap the
///    guarantee.
interface IProofVerifier {
    /// Name of the proving scheme this verifier implements, for the record kept when
    /// one is mounted in place of another.
    function scheme() external pure returns (string memory);

    /// Length in bytes of the proof body this verifier accepts.
    function proofLength() external pure returns (uint256);

    function verifyCompliance(bytes calldata proof, uint256[6] calldata publicSignals)
        external
        view
        returns (bool);
}
