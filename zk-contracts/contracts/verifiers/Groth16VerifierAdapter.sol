// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {IGroth16Verifier} from "../interfaces/IGroth16Verifier.sol";
import {IProofVerifier} from "../interfaces/IProofVerifier.sol";

/// Puts the Groth16 verifier snarkjs generated behind the scheme-agnostic boundary,
/// without touching a line of it.
///
/// The proof body is `abi.encode(a, b, c)`: three static arrays, so the encoding is
/// eight words end to end with no offsets, and `proofLength()` is the whole contract.
/// The coordinates arrive already in the order the pairing precompile wants, which is
/// the order `exportSolidityCallData` prints and the reverse of the order snarkjs keeps
/// internally for each Fp2 element of `B`; nothing here reorders them.
contract Groth16VerifierAdapter is IProofVerifier {
    uint256 private constant PROOF_LENGTH = 8 * 32;

    IGroth16Verifier public immutable verifier;

    error ZeroAddress();

    constructor(IGroth16Verifier verifier_) {
        if (address(verifier_) == address(0)) revert ZeroAddress();
        verifier = verifier_;
    }

    function scheme() external pure override returns (string memory) {
        return "groth16";
    }

    function proofLength() external pure override returns (uint256) {
        return PROOF_LENGTH;
    }

    /// The generated verifier checks every public signal against the scalar field
    /// itself and answers false when one falls outside, so this adapter adds nothing
    /// there. Its PLONK counterpart has to.
    function verifyCompliance(bytes calldata proof, uint256[6] calldata publicSignals)
        external
        view
        override
        returns (bool)
    {
        if (proof.length != PROOF_LENGTH) return false;

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));

        try verifier.verifyProof(a, b, c, publicSignals) returns (bool valid) {
            return valid;
        } catch {
            return false;
        }
    }
}
