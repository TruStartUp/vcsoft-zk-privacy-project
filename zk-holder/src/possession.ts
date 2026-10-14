import type { Address, Hex, LocalAccount, TypedDataDomain } from "viem";
import { recoverTypedDataAddress } from "viem";

/// Pinned: the RPC method, this domain and the struct together are the version of
/// the scheme the issuer verifies against.
export const DOMAIN_NAME = "VCSoft Confidentiality Layer";
export const DOMAIN_VERSION = "1";

export const activationTypes = {
  CredentialActivation: [
    { name: "credentialId", type: "string" },
    { name: "secretHash", type: "string" },
  ],
} as const;

export interface Deployment {
  chainId: number;
  credentialRegistry: Address;
}

export function holderDomain(deployment: Deployment): TypedDataDomain {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: deployment.chainId,
    verifyingContract: deployment.credentialRegistry,
  };
}

export function activationTypedData(deployment: Deployment, credentialId: string, secretHash: bigint) {
  return {
    domain: holderDomain(deployment),
    types: activationTypes,
    primaryType: "CredentialActivation" as const,
    message: { credentialId, secretHash: secretHash.toString(10) },
  };
}

/// What the wallet signs with `eth_signTypedData_v4`. It says nothing about the
/// secret and binds the hash to one pending credential.
export async function signActivation(
  account: LocalAccount,
  deployment: Deployment,
  credentialId: string,
  secretHash: bigint,
): Promise<Hex> {
  return account.signTypedData(activationTypedData(deployment, credentialId, secretHash));
}

export async function recoverActivationSigner(
  deployment: Deployment,
  credentialId: string,
  secretHash: bigint,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({ ...activationTypedData(deployment, credentialId, secretHash), signature });
}

/// The issuer cross-checks the domain it hands out with the pending credential;
/// a client that signs under another domain gets `activation_signature_mismatch`.
export function sameDomain(a: TypedDataDomain, b: TypedDataDomain): boolean {
  return (
    a.name === b.name &&
    a.version === b.version &&
    Number(a.chainId) === Number(b.chainId) &&
    String(a.verifyingContract).toLowerCase() === String(b.verifyingContract).toLowerCase()
  );
}
