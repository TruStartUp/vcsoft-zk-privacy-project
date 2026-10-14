import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { contracts as trex } from "@erc3643org/erc-3643";
import { Contract, Wallet, type Signer, type TransactionResponse } from "ethers";
import { task, types } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

/// Operator actions on the attestor and on the asset's token, for a local node and for
/// Base Sepolia. On Base Sepolia they sign with PLATFORM_PRIVATE_KEY, the wallet that
/// holds ATTESTATION_MANAGER_ROLE and is the token's agent; on a local node, with the
/// first unlocked account that holds the role. Any other chain is refused.

const LOCAL_CHAIN = 31337n;
const BASE_SEPOLIA = 84532n;
const POLL_MS = 2000;
const RECEIPT_TIMEOUT_MS = 10 * 60 * 1000;

interface Operator {
  signer: Signer;
  address: string;
  confirmations: number;
}

interface DeploymentRecord {
  parameters?: { assetId?: string };
  contracts?: Record<string, { address: string }>;
}

function deploymentOf(hre: HardhatRuntimeEnvironment): DeploymentRecord {
  const path = join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as DeploymentRecord) : {};
}

function resolveAddress(hre: HardhatRuntimeEnvironment, given: string | undefined, contract: string, flag: string): string {
  const address = given ?? deploymentOf(hre).contracts?.[contract]?.address;
  if (!address) throw new Error(`no ${contract} recorded for network ${hre.network.name}; pass --${flag}`);
  if (!hre.ethers.isAddress(address)) throw new Error(`--${flag} is not an address: ${address}`);
  return hre.ethers.getAddress(address);
}

function requireAddress(hre: HardhatRuntimeEnvironment, value: string, flag: string): string {
  if (!hre.ethers.isAddress(value)) throw new Error(`--${flag} is not an address: ${value}`);
  return hre.ethers.getAddress(value);
}

async function operator(
  hre: HardhatRuntimeEnvironment,
  holds: (address: string) => Promise<boolean>,
  what: string,
): Promise<Operator> {
  const { chainId } = await hre.ethers.provider.getNetwork();
  if (chainId === BASE_SEPOLIA) {
    const key = process.env.PLATFORM_PRIVATE_KEY?.trim();
    if (!key) throw new Error("PLATFORM_PRIVATE_KEY is not set");
    const wallet = new Wallet(key, hre.ethers.provider);
    if (!(await holds(wallet.address))) throw new Error(`${wallet.address} does not hold ${what}`);
    return { signer: wallet, address: wallet.address, confirmations: 2 };
  }
  if (chainId !== LOCAL_CHAIN) throw new Error(`refusing to operate on chainId ${chainId}: only a local node or Base Sepolia`);
  for (const signer of await hre.ethers.getSigners()) {
    if (await holds(signer.address)) return { signer, address: signer.address, confirmations: 1 };
  }
  throw new Error(`no local account holds ${what}`);
}

async function confirmed(hre: HardhatRuntimeEnvironment, tx: TransactionResponse, confirmations: number) {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await hre.ethers.provider.getTransactionReceipt(tx.hash).catch(() => null);
    if (receipt !== null) {
      const head = await hre.ethers.provider.getBlockNumber();
      if (head - receipt.blockNumber + 1 >= confirmations) {
        if (receipt.status !== 1) throw new Error(`transaction ${tx.hash} reverted`);
        return receipt;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`no receipt with ${confirmations} confirmation(s) for ${tx.hash}; check it on the explorer before retrying`);
}

async function send(
  hre: HardhatRuntimeEnvironment,
  who: Operator,
  label: string,
  submit: () => Promise<TransactionResponse>,
) {
  const tx = await submit();
  console.log(`  sent ${label} tx ${tx.hash} from ${who.address}`);
  const receipt = await confirmed(hre, tx, who.confirmations);
  console.log(`  confirmed in block ${receipt.blockNumber}, ${receipt.gasUsed} gas`);
  return { txHash: tx.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
}

task("attestation:revoke", "Revoke the attestation an address holds on an asset (ComplianceAttestor.revokeAttestation)")
  .addParam("subject", "The address whose attestation is revoked")
  .addOptionalParam("asset", "The asset id; defaults to the recorded deployment's", undefined, types.string)
  .addOptionalParam("attestor", "The ComplianceAttestor; defaults to the recorded deployment's", undefined, types.string)
  .addFlag("dryRun", "Check and report without sending anything")
  .setAction(async (args: { subject: string; asset?: string; attestor?: string; dryRun: boolean }, hre) => {
    require("./lib/redact");
    const subject = requireAddress(hre, args.subject, "subject");
    const asset = args.asset ?? deploymentOf(hre).parameters?.assetId;
    if (asset === undefined || !/^\d+$/.test(asset)) throw new Error(`no asset id recorded for network ${hre.network.name}; pass --asset`);
    const assetId = BigInt(asset);
    const attestorAddress = resolveAddress(hre, args.attestor, "complianceAttestor", "attestor");

    const attestor = await hre.ethers.getContractAt("ComplianceAttestor", attestorAddress);
    const role = await attestor.ATTESTATION_MANAGER_ROLE();
    const who = await operator(hre, (address) => attestor.hasRole(role, address), "ATTESTATION_MANAGER_ROLE");

    const before = await attestor.attestationOf(assetId, subject);
    console.log(`attestor ${attestorAddress} · asset ${assetId} · subject ${subject} · operator ${who.address}`);
    if (before.expiresAt === 0n) {
      console.log("  no attestation: nothing to revoke");
      return { revoked: false, subject, assetId: assetId.toString() };
    }
    console.log(`  attestation until ${new Date(Number(before.expiresAt) * 1000).toISOString()}, nullifier ${before.nullifier}`);
    if (args.dryRun) {
      console.log("  dry run: nothing sent");
      return { revoked: false, dryRun: true, subject, assetId: assetId.toString() };
    }

    const sent = await send(hre, who, "revokeAttestation", () =>
      attestor.connect(who.signer).revokeAttestation(assetId, subject) as Promise<TransactionResponse>,
    );
    const after = await attestor.attestationOf(assetId, subject);
    console.log(`  attested now: ${after.expiresAt !== 0n}`);
    return { revoked: true, subject, assetId: assetId.toString(), ...sent };
  });

async function tokenFor(hre: HardhatRuntimeEnvironment, given: string | undefined) {
  const address = resolveAddress(hre, given, "token", "token");
  const token = new Contract(address, trex.Token.abi, hre.ethers.provider);
  const who = await operator(hre, (candidate) => token.isAgent(candidate) as Promise<boolean>, "the token's agent role");
  return { token: token.connect(who.signer) as Contract, address, who, decimals: Number(await token.decimals()) };
}

async function holding(token: Contract, holder: string) {
  const [addressFrozen, balance, frozenTokens] = await Promise.all([
    token.isFrozen(holder) as Promise<boolean>,
    token.balanceOf(holder) as Promise<bigint>,
    token.getFrozenTokens(holder) as Promise<bigint>,
  ]);
  return { addressFrozen, balance, frozenTokens };
}

function freezeTask(name: string, freeze: boolean) {
  const verb = freeze ? "Freeze" : "Unfreeze";
  task(name, `${verb} a holder's address, or with --amount only that many tokens (T-REX agent functions)`)
    .addParam("holder", "The token holder")
    .addOptionalParam("amount", "Tokens, in whole units with decimals, to (un)freeze partially", undefined, types.string)
    .addOptionalParam("token", "The token; defaults to the recorded deployment's", undefined, types.string)
    .addFlag("dryRun", "Check and report without sending anything")
    .setAction(async (args: { holder: string; amount?: string; token?: string; dryRun: boolean }, hre) => {
      require("./lib/redact");
      const holder = requireAddress(hre, args.holder, "holder");
      const { token, address, who, decimals } = await tokenFor(hre, args.token);
      const units = (value: bigint) => hre.ethers.formatUnits(value, decimals);
      const describe = (state: Awaited<ReturnType<typeof holding>>) =>
        `address frozen ${state.addressFrozen}, balance ${units(state.balance)}, frozen tokens ${units(state.frozenTokens)}`;
      const report = (state: Awaited<ReturnType<typeof holding>>) => ({
        holder,
        addressFrozen: state.addressFrozen,
        balance: units(state.balance),
        frozenTokens: units(state.frozenTokens),
      });

      const before = await holding(token, holder);
      console.log(`token ${address} · holder ${holder} · operator ${who.address}`);
      console.log(`  before: ${describe(before)}`);

      let label: string;
      let submit: () => Promise<TransactionResponse>;
      if (args.amount === undefined) {
        if (before.addressFrozen === freeze) {
          console.log(`  the address is already ${freeze ? "frozen" : "unfrozen"}: nothing to send`);
          return { changed: false, ...report(before) };
        }
        label = `setAddressFrozen(${freeze})`;
        submit = () => token.setAddressFrozen(holder, freeze);
      } else {
        const amount = hre.ethers.parseUnits(args.amount, decimals);
        if (amount <= 0n) throw new Error("--amount must be positive");
        const available = freeze ? before.balance - before.frozenTokens : before.frozenTokens;
        if (amount > available) {
          throw new Error(`--amount ${args.amount} exceeds the ${freeze ? "unfrozen balance" : "frozen tokens"} (${units(available)})`);
        }
        label = `${freeze ? "freezePartialTokens" : "unfreezePartialTokens"}(${args.amount})`;
        submit = () => (freeze ? token.freezePartialTokens(holder, amount) : token.unfreezePartialTokens(holder, amount));
      }

      if (args.dryRun) {
        console.log(`  dry run: would send ${label}`);
        return { changed: false, dryRun: true, ...report(before) };
      }
      const sent = await send(hre, who, label, submit);
      const after = await holding(token, holder);
      console.log(`  after: ${describe(after)}`);
      return { changed: true, ...report(after), ...sent };
    });
}

freezeTask("token:freeze", true);
freezeTask("token:unfreeze", false);
