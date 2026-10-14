// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {Bn254Field} from "../libraries/Bn254Field.sol";
import {IPlonkVerifier} from "../interfaces/IPlonkVerifier.sol";
import {IProofVerifier} from "../interfaces/IProofVerifier.sol";

/// Puts the PLONK verifier snarkjs generated behind the scheme-agnostic boundary,
/// without touching a line of it, and closes the one gap that would otherwise make the
/// two schemes non-interchangeable.
///
/// **The gap.** The generated PLONK verifier checks its own proof body thoroughly --
/// every commitment on the curve, every coordinate and evaluation in the base field --
/// and then reads the public signals straight into `calculatePI` and the challenge
/// transcript, where they meet `mulmod` and `addmod` and are reduced modulo the scalar
/// order on the way. A signal presented as `s + r` is therefore accepted exactly as `s`
/// would have been. The Groth16 verifier refuses it instead, because it runs `checkField`
/// over the six signals before the pairing.
///
/// Left alone, that difference would turn a scheme swap into a silent change of what the
/// system accepts: two encodings of the same nullifier, and a caller checking spentness
/// against one of them while the attestor recorded the other. The check belongs here, at
/// the boundary, so the guarantee holds whichever verifier is mounted rather than
/// depending on which one is. `ComplianceAttestor` refuses the same signals earlier and
/// keeps doing so; this is not that check moved, it is the adapter earning its place as a
/// drop-in for the Groth16 one.
contract PlonkVerifierAdapter is IProofVerifier {
    uint256 private constant PROOF_LENGTH = 24 * 32;

    IPlonkVerifier public immutable verifier;

    error ZeroAddress();

    constructor(IPlonkVerifier verifier_) {
        if (address(verifier_) == address(0)) revert ZeroAddress();
        verifier = verifier_;
    }

    function scheme() external pure override returns (string memory) {
        return "plonk";
    }

    function proofLength() external pure override returns (uint256) {
        return PROOF_LENGTH;
    }

    function verifyCompliance(bytes calldata proof, uint256[6] calldata publicSignals)
        external
        view
        override
        returns (bool)
    {
        if (proof.length != PROOF_LENGTH) return false;

        for (uint256 i = 0; i < publicSignals.length; i++) {
            if (!Bn254Field.contains(publicSignals[i])) return false;
        }

        uint256[24] memory body = abi.decode(proof, (uint256[24]));

        try verifier.verifyProof(body, publicSignals) returns (bool valid) {
            return valid;
        } catch {
            return false;
        }
    }
}
