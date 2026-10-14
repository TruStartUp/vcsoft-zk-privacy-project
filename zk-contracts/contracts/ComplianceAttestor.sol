// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IComplianceAttestor} from "./interfaces/IComplianceAttestor.sol";
import {ICredentialRegistry} from "./interfaces/ICredentialRegistry.sol";
import {IProofVerifier} from "./interfaces/IProofVerifier.sol";
import {Bn254Field} from "./libraries/Bn254Field.sol";

/// Turns a compliance proof into an on-chain attestation for the holder its anchor names.
///
/// The circuit proves four predicates about six public signals; every assumption the
/// circuit cannot enforce itself is enforced here, before the pairing check: the period
/// claimed is a real boundary of the running epoch or the next one, the anchor names
/// the subject being attested on this chain and this contract, both roots come from the
/// registry state, the nullifier is unspent, and every signal is a canonical field element.
///
/// Who sends the transaction is irrelevant to all of that. The platform presents the
/// holder's proof and pays for it with `attestFor`; a copy taken from the mempool can
/// only ever attest the same subject, and only once.
///
/// The attestation is a standing permission, not a voucher: it is valid until the end
/// of the period it claims, and the holder transfers as often as they like inside it.
/// The epoch length is therefore the revocation latency of an attestation nobody
/// revoked by hand, and the renewal cadence of every investor.
///
/// The credential's expiry never appears here. The circuit refuses to prove a period
/// the credential does not survive, so `expiresAt` needs no clamping.
///
/// The proving scheme is not part of any of that. This contract holds an `IProofVerifier`
/// and hands it opaque bytes and the six signals; which scheme reads those bytes is a
/// deployment decision, and it can be taken again later without redeploying the attestor,
/// its roles, its spent nullifiers or the attestations already granted.
contract ComplianceAttestor is AccessControl, IComplianceAttestor {
    bytes32 public constant ATTESTATION_MANAGER_ROLE = keccak256("ATTESTATION_MANAGER_ROLE");

    uint64 public constant DEFAULT_EPOCH_LENGTH = 30 days;
    uint64 public constant MIN_EPOCH_LENGTH = 1 hours;
    uint64 public constant MAX_EPOCH_LENGTH = 90 days;

    ICredentialRegistry public immutable registry;

    /// Not immutable, and that is the point: a scheme is replaced by pointing this at
    /// another adapter. Everything the attestor has recorded survives the move.
    IProofVerifier public override verifier;

    uint64 public override epochLength;

    mapping(uint256 => bool) public override isNullifierSpent;
    mapping(uint256 => mapping(address => Attestation)) private _attestations;

    event ComplianceAttested(
        uint256 indexed assetId,
        address indexed subject,
        uint256 indexed nullifier,
        uint64 issuedAt,
        uint64 expiresAt
    );
    event AttestationRevoked(uint256 indexed assetId, address indexed subject, uint256 nullifier);
    event EpochLengthUpdated(uint64 previousLength, uint64 newLength);
    event VerifierUpdated(address indexed previousVerifier, address indexed newVerifier, string scheme);

    error ZeroAddress();
    error PublicSignalOutOfField(uint256 index, uint256 value);
    error EpochEndNotCurrent(uint256 epochEnd, uint256 runningEpochEnd);
    error AnchorMismatch(uint256 anchor, uint256 expectedAnchor);
    error CredentialRootNotValid(uint256 root);
    error AssetNotRegistered(uint256 assetId);
    error CountryRootNotValid(uint256 assetId, uint256 root);
    error NullifierAlreadySpent(uint256 nullifier);
    error InvalidProof();
    error EpochLengthOutOfRange(uint64 length, uint64 minLength, uint64 maxLength);
    error NoAttestation(uint256 assetId, address subject);
    error AttestationWouldShorten(uint64 currentExpiry, uint64 claimedExpiry);

    constructor(address admin, ICredentialRegistry registry_, IProofVerifier verifier_, uint64 initialEpochLength) {
        if (admin == address(0) || address(registry_) == address(0)) revert ZeroAddress();
        _requireUsableEpochLength(initialEpochLength);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        registry = registry_;
        _setVerifier(verifier_);
        epochLength = initialEpochLength;
        emit EpochLengthUpdated(0, initialEpochLength);
    }

    /// Rotating the scheme is a live change and it is meant to be: proofs built for the
    /// verifier that is leaving stop being accepted the moment this lands, and holders
    /// re-prove under the new one. Nullifiers already spent stay spent, so the rotation
    /// cannot be used to replay anything.
    function setVerifier(IProofVerifier newVerifier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setVerifier(newVerifier);
    }

    /// Periods are counted from the unix epoch, so a new length moves every boundary:
    /// proofs already built against the old boundaries stop being accepted, and an
    /// attestation issued under the old ones keeps the expiry it was given.
    function setEpochLength(uint64 newLength) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireUsableEpochLength(newLength);
        emit EpochLengthUpdated(epochLength, newLength);
        epochLength = newLength;
    }

    function attest(bytes calldata proof, uint256[6] calldata publicSignals) external override {
        _attest(msg.sender, proof, publicSignals);
    }

    function attestFor(address subject, bytes calldata proof, uint256[6] calldata publicSignals)
        external
        override
    {
        if (subject == address(0)) revert ZeroAddress();
        _attest(subject, proof, publicSignals);
    }

    function revokeAttestation(uint256 assetId, address subject) external onlyRole(ATTESTATION_MANAGER_ROLE) {
        Attestation memory attestation = _attestations[assetId][subject];
        if (attestation.expiresAt == 0) revert NoAttestation(assetId, subject);
        delete _attestations[assetId][subject];
        emit AttestationRevoked(assetId, subject, attestation.nullifier);
    }

    /// What the circuit must carry as `anchor` for a proof to attest this subject. The
    /// subject is named by the proof, never by whoever sends it: a mempool observer who
    /// copies the proof cannot make it name them. No other chain and no other
    /// deployment accepts it either.
    function anchorFor(address subject) public view override returns (uint256) {
        return uint256(keccak256(abi.encode(subject, block.chainid, address(this)))) % Bn254Field.ORDER;
    }

    function currentEpochEnd() public view override returns (uint256) {
        return (block.timestamp / epochLength + 1) * epochLength;
    }

    function isAttested(uint256 assetId, address subject) public view override returns (bool) {
        return block.timestamp < _attestations[assetId][subject].expiresAt;
    }

    function attestationOf(uint256 assetId, address subject) external view override returns (Attestation memory) {
        return _attestations[assetId][subject];
    }

    function attestationExpiry(uint256 assetId, address subject) external view override returns (uint64) {
        return _attestations[assetId][subject].expiresAt;
    }

    /// The next period is claimable so the platform can renew before the running one
    /// ends and leave no window in which a compliant investor cannot transfer. Anything
    /// that is not one of those two boundaries -- a past period, a distant one, a value
    /// that is not a multiple of the epoch length at all -- is refused.
    function _requireClaimablePeriod(uint256 epochEnd) private view {
        uint256 running = currentEpochEnd();
        if (epochEnd != running && epochEnd != running + epochLength) revert EpochEndNotCurrent(epochEnd, running);
    }

    function _attest(address subject, bytes calldata proof, uint256[6] calldata publicSignals) private {
        for (uint256 i = 0; i < publicSignals.length; i++) {
            if (!Bn254Field.contains(publicSignals[i])) revert PublicSignalOutOfField(i, publicSignals[i]);
        }

        _requireClaimablePeriod(publicSignals[3]);
        _requireAnchorOf(subject, publicSignals[5]);
        _requirePublishedRoots(publicSignals[2], publicSignals[0], publicSignals[1]);

        uint256 nullifier = publicSignals[4];
        if (isNullifierSpent[nullifier]) revert NullifierAlreadySpent(nullifier);

        uint256 assetId = publicSignals[2];
        uint64 expiresAt = uint64(publicSignals[3]);
        _requireNoShortening(assetId, subject, expiresAt);

        if (!verifier.verifyCompliance(proof, publicSignals)) revert InvalidProof();

        isNullifierSpent[nullifier] = true;

        uint64 issuedAt = uint64(block.timestamp);
        _attestations[assetId][subject] = Attestation({
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            nullifier: nullifier
        });

        emit ComplianceAttested(assetId, subject, nullifier, issuedAt, expiresAt);
    }

    /// A claimed period always ends in the future, so an existing expiry beyond it is a
    /// live attestation. Letting a proof for an earlier period land on top of it would
    /// let whoever orders two pending proofs of the same holder shorten that holder's
    /// attestation and burn the later nullifier.
    function _requireNoShortening(uint256 assetId, address subject, uint64 claimedExpiry) private view {
        uint64 currentExpiry = _attestations[assetId][subject].expiresAt;
        if (currentExpiry > claimedExpiry) revert AttestationWouldShorten(currentExpiry, claimedExpiry);
    }

    function _requireAnchorOf(address subject, uint256 anchor) private view {
        uint256 expected = anchorFor(subject);
        if (anchor != expected) revert AnchorMismatch(anchor, expected);
    }

    function _requirePublishedRoots(uint256 assetId, uint256 credentialRoot, uint256 countryRoot) private view {
        if (!registry.isCredentialRootValid(credentialRoot)) revert CredentialRootNotValid(credentialRoot);
        if (registry.countryRootOf(assetId) == 0) revert AssetNotRegistered(assetId);
        if (!registry.isCountryRootValid(assetId, countryRoot)) revert CountryRootNotValid(assetId, countryRoot);
    }

    function _setVerifier(IProofVerifier newVerifier) private {
        if (address(newVerifier) == address(0)) revert ZeroAddress();
        emit VerifierUpdated(address(verifier), address(newVerifier), newVerifier.scheme());
        verifier = newVerifier;
    }

    function _requireUsableEpochLength(uint64 length) private pure {
        if (length < MIN_EPOCH_LENGTH || length > MAX_EPOCH_LENGTH) {
            revert EpochLengthOutOfRange(length, MIN_EPOCH_LENGTH, MAX_EPOCH_LENGTH);
        }
    }
}
