// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {ICredentialRegistry} from "./interfaces/ICredentialRegistry.sol";
import {Bn254Field} from "./libraries/Bn254Field.sol";

/// Source of truth for the Merkle roots the compliance circuit is proven against.
///
/// The trees themselves live off chain; the registry stores their roots and emits
/// every leaf change so that any observer can rebuild both trees from the log.
///
/// A superseded root stays acceptable for `rootValidityWindow` seconds. That window
/// is, by definition, the revocation latency of the whole system: a credential taken
/// out of the tree still proves membership against the previous root until the window
/// closes. `invalidateCredentialRoot` drops it to zero for a single root.
contract CredentialRegistry is AccessControl, ICredentialRegistry {
    struct CredentialLeafUpdate {
        uint256 leafIndex;
        uint256 commitment;
        bool inserted;
    }

    struct CountryLeafUpdate {
        uint256 leafIndex;
        uint16 countryCode;
        bool admitted;
    }

    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant JURISDICTION_ROLE = keccak256("JURISDICTION_ROLE");

    uint256 public constant CREDENTIAL_TREE_DEPTH = 20;
    uint256 public constant COUNTRY_TREE_DEPTH = 8;

    uint64 public constant DEFAULT_ROOT_VALIDITY_WINDOW = 15 minutes;
    uint64 public constant MAX_ROOT_VALIDITY_WINDOW = 1 days;

    uint64 public override rootValidityWindow;
    uint256 public override credentialRoot;

    mapping(uint256 => uint64) public credentialRootSupersededAt;
    mapping(uint256 => uint256) public override countryRootOf;
    mapping(uint256 => mapping(uint256 => uint64)) public countryRootSupersededAt;

    event CredentialRootPublished(uint256 indexed newRoot, uint256 indexed previousRoot, uint256 publishedAt);
    event CredentialLeafUpdated(
        uint256 indexed newRoot,
        uint256 indexed leafIndex,
        uint256 indexed commitment,
        bool inserted
    );
    event CredentialRootInvalidated(uint256 indexed root);
    event CountryRootPublished(
        uint256 indexed assetId,
        uint256 indexed newRoot,
        uint256 indexed previousRoot,
        uint256 publishedAt
    );
    event CountryLeafUpdated(
        uint256 indexed assetId,
        uint256 indexed newRoot,
        uint256 indexed leafIndex,
        uint16 countryCode,
        bool admitted
    );
    event CountryRootInvalidated(uint256 indexed assetId, uint256 indexed root);
    event RootValidityWindowUpdated(uint64 previousWindow, uint64 newWindow);

    error ZeroAddress();
    error NotAFieldElement(uint256 value);
    error ZeroRoot();
    error RootUnchanged(uint256 root);
    error LeafIndexOutOfRange(uint256 leafIndex, uint256 depth);
    error ZeroCommitment(uint256 leafIndex);
    error PaddingCountryCode(uint256 leafIndex);
    error WindowTooLong(uint64 window, uint64 maxWindow);
    error RootIsCurrent(uint256 root);
    error UnknownRoot(uint256 root);

    constructor(address admin, uint64 initialRootValidityWindow) {
        if (admin == address(0)) revert ZeroAddress();
        if (initialRootValidityWindow > MAX_ROOT_VALIDITY_WINDOW) {
            revert WindowTooLong(initialRootValidityWindow, MAX_ROOT_VALIDITY_WINDOW);
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        rootValidityWindow = initialRootValidityWindow;
        emit RootValidityWindowUpdated(0, initialRootValidityWindow);
    }

    function setRootValidityWindow(uint64 newWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newWindow > MAX_ROOT_VALIDITY_WINDOW) revert WindowTooLong(newWindow, MAX_ROOT_VALIDITY_WINDOW);
        emit RootValidityWindowUpdated(rootValidityWindow, newWindow);
        rootValidityWindow = newWindow;
    }

    function publishCredentialRoot(uint256 newRoot, CredentialLeafUpdate[] calldata updates)
        external
        onlyRole(ISSUER_ROLE)
    {
        _requireUsableRoot(newRoot);
        uint256 previousRoot = credentialRoot;
        if (newRoot == previousRoot) revert RootUnchanged(newRoot);

        for (uint256 i = 0; i < updates.length; i++) {
            CredentialLeafUpdate calldata update = updates[i];
            if (update.leafIndex >= (1 << CREDENTIAL_TREE_DEPTH)) {
                revert LeafIndexOutOfRange(update.leafIndex, CREDENTIAL_TREE_DEPTH);
            }
            if (update.commitment == 0) revert ZeroCommitment(update.leafIndex);
            if (!Bn254Field.contains(update.commitment)) revert NotAFieldElement(update.commitment);
            emit CredentialLeafUpdated(newRoot, update.leafIndex, update.commitment, update.inserted);
        }

        if (previousRoot != 0) credentialRootSupersededAt[previousRoot] = uint64(block.timestamp);
        credentialRootSupersededAt[newRoot] = 0;
        credentialRoot = newRoot;
        emit CredentialRootPublished(newRoot, previousRoot, block.timestamp);
    }

    function invalidateCredentialRoot(uint256 root) external onlyRole(ISSUER_ROLE) {
        if (root == credentialRoot) revert RootIsCurrent(root);
        if (credentialRootSupersededAt[root] == 0) revert UnknownRoot(root);
        credentialRootSupersededAt[root] = 0;
        emit CredentialRootInvalidated(root);
    }

    function publishCountryRoot(uint256 assetId, uint256 newRoot, CountryLeafUpdate[] calldata updates)
        external
        onlyRole(JURISDICTION_ROLE)
    {
        _requireUsableRoot(newRoot);
        uint256 previousRoot = countryRootOf[assetId];
        if (newRoot == previousRoot) revert RootUnchanged(newRoot);

        for (uint256 i = 0; i < updates.length; i++) {
            CountryLeafUpdate calldata update = updates[i];
            if (update.leafIndex >= (1 << COUNTRY_TREE_DEPTH)) {
                revert LeafIndexOutOfRange(update.leafIndex, COUNTRY_TREE_DEPTH);
            }
            if (update.countryCode == 0) revert PaddingCountryCode(update.leafIndex);
            emit CountryLeafUpdated(assetId, newRoot, update.leafIndex, update.countryCode, update.admitted);
        }

        if (previousRoot != 0) countryRootSupersededAt[assetId][previousRoot] = uint64(block.timestamp);
        countryRootSupersededAt[assetId][newRoot] = 0;
        countryRootOf[assetId] = newRoot;
        emit CountryRootPublished(assetId, newRoot, previousRoot, block.timestamp);
    }

    function invalidateCountryRoot(uint256 assetId, uint256 root) external onlyRole(JURISDICTION_ROLE) {
        if (root == countryRootOf[assetId]) revert RootIsCurrent(root);
        if (countryRootSupersededAt[assetId][root] == 0) revert UnknownRoot(root);
        countryRootSupersededAt[assetId][root] = 0;
        emit CountryRootInvalidated(assetId, root);
    }

    function isCredentialRootValid(uint256 root) public view override returns (bool) {
        if (root == 0) return false;
        if (root == credentialRoot) return true;
        return _withinWindow(credentialRootSupersededAt[root]);
    }

    function isCountryRootValid(uint256 assetId, uint256 root) public view override returns (bool) {
        if (root == 0) return false;
        if (root == countryRootOf[assetId]) return true;
        return _withinWindow(countryRootSupersededAt[assetId][root]);
    }

    function _withinWindow(uint64 supersededAt) private view returns (bool) {
        return supersededAt != 0 && block.timestamp <= uint256(supersededAt) + rootValidityWindow;
    }

    function _requireUsableRoot(uint256 root) private pure {
        if (root == 0) revert ZeroRoot();
        if (!Bn254Field.contains(root)) revert NotAFieldElement(root);
    }
}
