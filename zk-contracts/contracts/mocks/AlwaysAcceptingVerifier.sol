// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {IGroth16Verifier} from "../interfaces/IGroth16Verifier.sol";
import {IPlonkVerifier} from "../interfaces/IPlonkVerifier.sol";

/// A verifier that accepts everything, so a test can ask what an adapter decides on its
/// own rather than what the cryptography decided for it.
///
/// Put behind each adapter it answers one question that a real verifier cannot: which of
/// the two checks the public signals itself. The Groth16 adapter turns permissive, because
/// the verifier snarkjs generates is what refuses a signal outside the scalar field. The
/// PLONK adapter does not, because there the check is its own.
contract AlwaysAcceptingVerifier is IGroth16Verifier, IPlonkVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[6] calldata)
        external
        pure
        override
        returns (bool)
    {
        return true;
    }

    function verifyProof(uint256[24] calldata, uint256[6] calldata) external pure override returns (bool) {
        return true;
    }
}
