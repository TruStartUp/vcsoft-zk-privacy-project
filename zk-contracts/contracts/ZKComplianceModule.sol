// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {AbstractModuleUpgradeable} from
    "@erc3643org/erc-3643/contracts/compliance/modular/modules/AbstractModuleUpgradeable.sol";

import {IComplianceAttestor} from "./interfaces/IComplianceAttestor.sol";

/// ERC-3643 compliance module gated by the confidentiality layer.
///
/// `moduleCheck` is a view: it cannot receive a proof. The proof is presented earlier to
/// `ComplianceAttestor`, and this module only asks whether the receiver holds a live
/// attestation for the asset bound to the calling compliance contract.
///
/// A compliance contract with no asset bound admits no transfer, and an asset id is
/// bound to at most one compliance: two tokens sharing an id would share every
/// attestation earned on either of them. The first compliance to claim an id keeps it;
/// the owner releases it when a deployment is retired or an id was claimed in bad faith.
contract ZKComplianceModule is AbstractModuleUpgradeable {
    IComplianceAttestor public attestor;

    mapping(address => uint256) public assetIdOf;
    mapping(uint256 => address) public complianceOfAsset;

    event AttestorSet(address indexed attestor);
    event AssetIdSet(address indexed compliance, uint256 indexed assetId);
    event AssetIdReleased(address indexed compliance, uint256 indexed assetId);

    error ZeroAddress();
    error ZeroAssetId();
    error AssetIdAlreadyBound(uint256 assetId, address compliance);
    error AssetIdNotBound(uint256 assetId);

    function initialize(IComplianceAttestor attestor_) external initializer {
        if (address(attestor_) == address(0)) revert ZeroAddress();
        __AbstractModule_init();
        attestor = attestor_;
        emit AttestorSet(address(attestor_));
    }

    function setAttestor(IComplianceAttestor attestor_) external onlyOwner {
        if (address(attestor_) == address(0)) revert ZeroAddress();
        attestor = attestor_;
        emit AttestorSet(address(attestor_));
    }

    function setAssetId(uint256 assetId) external onlyComplianceCall {
        if (assetId == 0) revert ZeroAssetId();
        address holder = complianceOfAsset[assetId];
        if (holder != address(0) && holder != msg.sender) revert AssetIdAlreadyBound(assetId, holder);

        uint256 previous = assetIdOf[msg.sender];
        if (previous != 0) delete complianceOfAsset[previous];

        assetIdOf[msg.sender] = assetId;
        complianceOfAsset[assetId] = msg.sender;
        emit AssetIdSet(msg.sender, assetId);
    }

    function releaseAssetId(uint256 assetId) external onlyOwner {
        address holder = complianceOfAsset[assetId];
        if (holder == address(0)) revert AssetIdNotBound(assetId);
        delete complianceOfAsset[assetId];
        delete assetIdOf[holder];
        emit AssetIdReleased(holder, assetId);
    }

    // solhint-disable-next-line no-empty-blocks
    function moduleTransferAction(address, address, uint256) external override onlyComplianceCall {}

    // solhint-disable-next-line no-empty-blocks
    function moduleMintAction(address, uint256) external override onlyComplianceCall {}

    // solhint-disable-next-line no-empty-blocks
    function moduleBurnAction(address, uint256) external override onlyComplianceCall {}

    function moduleCheck(address, address _to, uint256, address _compliance)
        external
        view
        override
        returns (bool)
    {
        uint256 assetId = assetIdOf[_compliance];
        if (assetId == 0) return false;
        return attestor.isAttested(assetId, _to);
    }

    function canComplianceBind(address) external pure override returns (bool) {
        return true;
    }

    function isPlugAndPlay() external pure override returns (bool) {
        return true;
    }

    function name() public pure override returns (string memory) {
        return "ZKComplianceModule";
    }
}
