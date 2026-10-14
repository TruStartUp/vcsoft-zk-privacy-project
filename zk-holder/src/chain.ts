import { parseAbi, type Address, type PublicClient } from "viem";

export const complianceAttestorAbi = parseAbi([
  "struct Attestation { uint64 issuedAt; uint64 expiresAt; uint256 nullifier; }",
  "function anchorFor(address subject) view returns (uint256)",
  "function currentEpochEnd() view returns (uint256)",
  "function epochLength() view returns (uint64)",
  "function attestationOf(uint256 assetId, address subject) view returns (Attestation)",
  "function isAttested(uint256 assetId, address subject) view returns (bool)",
  "function isNullifierSpent(uint256 nullifier) view returns (bool)",
  "function attestFor(address subject, bytes proof, uint256[6] publicSignals)",
  "function revokeAttestation(uint256 assetId, address subject)",
  "event ComplianceAttested(uint256 indexed assetId, address indexed subject, uint256 indexed nullifier, uint64 issuedAt, uint64 expiresAt)",
  "event AttestationRevoked(uint256 indexed assetId, address indexed subject, uint256 nullifier)",
  "error ZeroAddress()",
  "error PublicSignalOutOfField(uint256 index, uint256 value)",
  "error EpochEndNotCurrent(uint256 epochEnd, uint256 runningEpochEnd)",
  "error AnchorMismatch(uint256 anchor, uint256 expectedAnchor)",
  "error CredentialRootNotValid(uint256 root)",
  "error AssetNotRegistered(uint256 assetId)",
  "error CountryRootNotValid(uint256 assetId, uint256 root)",
  "error NullifierAlreadySpent(uint256 nullifier)",
  "error InvalidProof()",
  "error NoAttestation(uint256 assetId, address subject)",
  "error AttestationWouldShorten(uint64 currentExpiry, uint64 claimedExpiry)",
]);

export interface ProvingContext {
  currentEpochEnd: bigint;
  epochLength: bigint;
  epochEnd: bigint;
  anchor: bigint;
  blockNumber: bigint;
}

/// Everything the witness needs from the chain, read at one block. The period
/// claimed is the next one, so a proof generated near a boundary still lands.
export async function readProvingContext(
  client: PublicClient,
  attestor: Address,
  subject: Address,
): Promise<ProvingContext> {
  const blockNumber = await client.getBlockNumber();
  const read = <T>(functionName: "currentEpochEnd" | "epochLength" | "anchorFor", args?: readonly [Address]) =>
    client.readContract({ address: attestor, abi: complianceAttestorAbi, functionName, args, blockNumber } as never) as Promise<T>;
  const [currentEpochEnd, epochLength, anchor] = await Promise.all([
    read<bigint>("currentEpochEnd"),
    read<bigint>("epochLength"),
    read<bigint>("anchorFor", [subject]),
  ]);
  return { currentEpochEnd, epochLength, epochEnd: currentEpochEnd + epochLength, anchor, blockNumber };
}
