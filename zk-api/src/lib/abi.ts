import { parseAbi } from "viem";

export const credentialRegistryAbi = parseAbi([
  "struct CredentialLeafUpdate { uint256 leafIndex; uint256 commitment; bool inserted; }",
  "struct CountryLeafUpdate { uint256 leafIndex; uint16 countryCode; bool admitted; }",
  "function credentialRoot() view returns (uint256)",
  "function countryRootOf(uint256 assetId) view returns (uint256)",
  "function isCredentialRootValid(uint256 root) view returns (bool)",
  "function isCountryRootValid(uint256 assetId, uint256 root) view returns (bool)",
  "function publishCredentialRoot(uint256 newRoot, CredentialLeafUpdate[] updates)",
  "function publishCountryRoot(uint256 assetId, uint256 newRoot, CountryLeafUpdate[] updates)",
  "function invalidateCredentialRoot(uint256 root)",
  "function invalidateCountryRoot(uint256 assetId, uint256 root)",
  "event CredentialRootPublished(uint256 indexed newRoot, uint256 indexed previousRoot, uint256 publishedAt)",
  "event CredentialLeafUpdated(uint256 indexed newRoot, uint256 indexed leafIndex, uint256 indexed commitment, bool inserted)",
  "event CountryRootPublished(uint256 indexed assetId, uint256 indexed newRoot, uint256 indexed previousRoot, uint256 publishedAt)",
  "event CountryLeafUpdated(uint256 indexed assetId, uint256 indexed newRoot, uint256 indexed leafIndex, uint16 countryCode, bool admitted)",
  "error NotAFieldElement(uint256 value)",
  "error ZeroRoot()",
  "error RootUnchanged(uint256 root)",
  "error LeafIndexOutOfRange(uint256 leafIndex, uint256 depth)",
  "error ZeroCommitment(uint256 leafIndex)",
  "error PaddingCountryCode(uint256 leafIndex)",
  "error RootIsCurrent(uint256 root)",
  "error UnknownRoot(uint256 root)",
]);

/// Read-only on purpose. The service never presents a proof: the platform does,
/// through `attestFor`, and this service only reads what that call left behind.
export const complianceAttestorAbi = parseAbi([
  "struct Attestation { uint64 issuedAt; uint64 expiresAt; uint256 nullifier; }",
  "function currentEpochEnd() view returns (uint256)",
  "function epochLength() view returns (uint64)",
  "function attestationOf(uint256 assetId, address subject) view returns (Attestation)",
  "function isNullifierSpent(uint256 nullifier) view returns (bool)",
]);
