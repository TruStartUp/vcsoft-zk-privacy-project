import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { formatEther, getAddress, type Address, type Hash, type PublicClient } from "viem";

export interface WalletRecord {
  privateKey: `0x${string}`;
  address: Address;
}

export interface PartnerRecord {
  id: string;
  partnerKey: string;
  name: string;
  scopes: string[];
  secret: string;
}

export interface TxRecord {
  label: string;
  hash: Hash;
  from: Address;
  signer: string;
  via: string;
  status: "success" | "reverted";
  block: string;
  gasUsed: string;
  effectiveGasPrice: string;
  l1Fee: string;
  feeWei: string;
}

export interface InvestorRecord {
  wallet: WalletRecord;
  countryCode: number;
  identity?: Address;
  registered?: boolean;
  kycSubjectId?: string;
  credentialId?: string;
  expiresAt?: string;
  backup?: unknown;
  passphrase?: string;
  secretHash?: string;
  commitment?: string;
  activated?: boolean;
  nullifier?: string;
  epochEnd?: string;
  callData?: unknown;
  verificationId?: string;
  attested?: boolean;
  revoked?: boolean;
}

export interface E2EState {
  runId: string;
  startedAt: string;
  baseline?: { block: string; balances: Record<string, string> };
  partners: Record<string, PartnerRecord>;
  investors: Record<string, InvestorRecord>;
  jurisdictions?: { admitted: number[]; countryRoot: string; txHash: Hash };
  minted?: boolean;
  funded?: boolean;
  transferred?: boolean;
  transferGas?: string;
  revocation?: Record<string, unknown>;
  attestationRevoked?: boolean;
  refusedTransfer?: boolean;
  disclosure?: Record<string, unknown>;
  completed: string[];
  txs: TxRecord[];
}

export class Store {
  constructor(
    private readonly path: string,
    readonly state: E2EState,
  ) {}

  static open(path: string, fresh: () => E2EState): Store {
    if (existsSync(path)) return new Store(path, JSON.parse(readFileSync(path, "utf8")) as E2EState);
    mkdirSync(dirname(path), { recursive: true });
    const store = new Store(path, fresh());
    store.save();
    return store;
  }

  save(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  done(step: string): boolean {
    return this.state.completed.includes(step);
  }

  complete(step: string): void {
    if (!this.done(step)) this.state.completed.push(step);
    this.save();
  }
}

/// Every line goes to the terminal and to the raw evidence log, with every secret
/// this process knows about replaced first.
export class Log {
  private readonly secrets = new Set<string>();

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  secret(value: string | bigint | undefined, alsoDecimal = true): void {
    if (value === undefined) return;
    const text = typeof value === "bigint" ? value.toString() : value;
    if (text.length < 8) return;
    this.secrets.add(text);
    if (text.startsWith("0x")) this.secrets.add(text.slice(2));
    if (typeof value === "bigint") {
      this.secrets.add(value.toString(16));
      if (alsoDecimal) this.secrets.add(value.toString(10));
    }
    const lastSegment = text.split("/").pop();
    if (lastSegment && lastSegment.length >= 16 && lastSegment !== text) this.secrets.add(lastSegment);
  }

  redact(text: string): string {
    let result = text;
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      result = result.split(secret).join("[redacted]");
    }
    return result;
  }

  line(text = ""): void {
    const stamped = text.length === 0 ? "" : `[${new Date().toISOString()}] ${text}`;
    const safe = this.redact(stamped);
    process.stdout.write(`${safe}\n`);
    appendFileSync(this.path, `${safe}\n`);
  }

  json(label: string, value: unknown): void {
    this.line(`${label} ${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }

  step(title: string): void {
    this.line();
    this.line(`=== ${title}`);
  }
}

export class StopError extends Error {}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StopError(`comprobación fallida: ${message}`);
}

export const basescanTx = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;

export async function receiptRecord(
  client: PublicClient,
  hash: Hash,
  label: string,
  signer: string,
  via: string,
  confirmations: number,
): Promise<TxRecord> {
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations, timeout: 300_000 });
  const l1Fee = (receipt as { l1Fee?: bigint | null }).l1Fee ?? 0n;
  const fee = receipt.gasUsed * receipt.effectiveGasPrice + l1Fee;
  return {
    label,
    hash,
    from: getAddress(receipt.from),
    signer,
    via,
    status: receipt.status,
    block: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    l1Fee: l1Fee.toString(),
    feeWei: fee.toString(),
  };
}

export const eth = (wei: bigint | string) => `${formatEther(BigInt(wei))} ETH`;
