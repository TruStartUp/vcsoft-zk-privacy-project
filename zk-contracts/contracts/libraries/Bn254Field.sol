// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/// Order of the scalar field the circuit is defined over.
library Bn254Field {
    uint256 internal constant ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function contains(uint256 value) internal pure returns (bool) {
        return value < ORDER;
    }
}
