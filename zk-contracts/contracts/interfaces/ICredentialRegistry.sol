// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface ICredentialRegistry {
    function credentialRoot() external view returns (uint256);

    function countryRootOf(uint256 assetId) external view returns (uint256);

    function isCredentialRootValid(uint256 root) external view returns (bool);

    function isCountryRootValid(uint256 assetId, uint256 root) external view returns (bool);

    function rootValidityWindow() external view returns (uint64);
}
