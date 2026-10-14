// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {IProofVerifier} from "./IProofVerifier.sol";

interface IComplianceAttestor {
    struct Attestation {
        uint64 issuedAt;
        uint64 expiresAt;
        uint256 nullifier;
    }

    /// The proof is whatever the mounted verifier reads: this interface never names a
    /// scheme, and neither does the attestor behind it.
    function attest(bytes calldata proof, uint256[6] calldata publicSignals) external;

    /// Anyone may present the proof; the attestation goes to `subject`, and only if the
    /// proof's anchor names it. `attest` is this call with `msg.sender` as the subject.
    function attestFor(address subject, bytes calldata proof, uint256[6] calldata publicSignals) external;

    function verifier() external view returns (IProofVerifier);

    function anchorFor(address subject) external view returns (uint256);

    function currentEpochEnd() external view returns (uint256);

    function epochLength() external view returns (uint64);

    function isAttested(uint256 assetId, address subject) external view returns (bool);

    function attestationOf(uint256 assetId, address subject) external view returns (Attestation memory);

    function attestationExpiry(uint256 assetId, address subject) external view returns (uint64);

    function isNullifierSpent(uint256 nullifier) external view returns (bool);
}
