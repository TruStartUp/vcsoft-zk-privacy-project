import {
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";

import { complianceAttestorAbi } from "./chain.js";

/// The platform's side: it submits the holder's proof with `attestFor` and pays the gas.
export type PresentationOutcome =
  | { status: "attested"; txHash: Hash; receipt: TransactionReceipt }
  | { status: "already_attested"; nullifier: bigint }
  | { status: "already_covered"; currentExpiry: bigint; claimedExpiry: bigint };

export function revertName(error: unknown): { name: string; args: readonly unknown[] } | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  if (reverted.data?.errorName === "Error" && typeof reverted.data.args?.[0] === "string") {
    return { name: reverted.data.args[0], args: [] };
  }
  if (reverted.data?.errorName) return { name: reverted.data.errorName, args: reverted.data.args ?? [] };
  if (reverted.reason) return { name: reverted.reason, args: [] };
  return null;
}

export interface Presentation {
  publicClient: PublicClient;
  walletClient: WalletClient;
  attestor: Address;
  subject: Address;
  proof: `0x${string}`;
  signals: readonly bigint[];
  confirmations?: number;
}

/// `NullifierAlreadySpent` is a success when the subject's attestation already
/// carries that nullifier: someone presented the same proof first.
/// `AttestationWouldShorten` means the subject is covered past this period.
export async function presentForSubject(p: Presentation): Promise<PresentationOutcome> {
  const assetId = p.signals[2]!;
  const nullifier = p.signals[4]!;
  const args = [p.subject, p.proof, p.signals as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint]] as const;

  const settled = async (error: unknown): Promise<PresentationOutcome> => {
    const reverted = revertName(error);
    if (reverted?.name === "NullifierAlreadySpent") {
      const current = await p.publicClient.readContract({
        address: p.attestor,
        abi: complianceAttestorAbi,
        functionName: "attestationOf",
        args: [assetId, p.subject],
      });
      if (current.nullifier === nullifier) return { status: "already_attested", nullifier };
    }
    if (reverted?.name === "AttestationWouldShorten") {
      const [currentExpiry, claimedExpiry] = reverted.args as [bigint, bigint];
      return { status: "already_covered", currentExpiry, claimedExpiry };
    }
    throw error;
  };

  let request;
  try {
    ({ request } = await p.publicClient.simulateContract({
      account: p.walletClient.account!,
      address: p.attestor,
      abi: complianceAttestorAbi,
      functionName: "attestFor",
      args,
    }));
  } catch (error) {
    return settled(error);
  }

  const txHash = await p.walletClient.writeContract(request);
  const receipt = await p.publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: p.confirmations ?? 1 });
  if (receipt.status !== "success") {
    const current = await p.publicClient.readContract({
      address: p.attestor,
      abi: complianceAttestorAbi,
      functionName: "attestationOf",
      args: [assetId, p.subject],
    });
    if (current.nullifier === nullifier) return { status: "already_attested", nullifier };
    throw new Error(`attestFor reverted on chain: ${txHash}`);
  }
  return { status: "attested", txHash, receipt };
}
