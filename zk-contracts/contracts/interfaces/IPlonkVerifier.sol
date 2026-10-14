// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/// The verifier snarkjs generates for PLONK, exactly as generated.
interface IPlonkVerifier {
    function verifyProof(uint256[24] calldata proof, uint256[6] calldata publicSignals)
        external
        view
        returns (bool);
}
