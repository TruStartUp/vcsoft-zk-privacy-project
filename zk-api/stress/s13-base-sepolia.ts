import "./lib/load-env.js";

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseAbiItem,
  parseEther,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { presentForSubject } from "../../zk-holder/src/presenter.js";
import { attestorArguments } from "../../zk-holder/src/prover.js";
import { complianceAttestorAbi } from "../../zk-holder/src/chain.js";
import { StressClient, type PartnerCredentials } from "./lib/client.js";
import { REPO_DIR, hasJson, readJson, writeJson } from "./lib/env.js";
import { activate, groth16CallData, newHolder, register, releaseProver, witnessFor, type Holder } from "./lib/holder.js";
import { restoreHolder, serializeHolder, type StoredHolder } from "./lib/holders.js";
import { startService, summarizeServiceLog } from "./lib/service.js";
import { formatSummary, heading, json, line, machine, ms, summarize } from "./lib/stats.js";

const HOLDERS = 3;
const BUDGET = parseEther("0.0005");
const MARGIN = parseEther("0.00005");
const CONFIRMATIONS = 2;
const READS = 20;
const STATE = "s13-state.json";
const API_PORT = "3073";

const chainEnv = parse(readFileSync(resolve(REPO_DIR, "zk-contracts/.env")));
const deployment = JSON.parse(readFileSync(resolve(REPO_DIR, "zk-contracts/deployments/baseSepolia.json"), "utf8")) as {
  chainId: number;
  parameters: { assetId: string; deployer: Address; platform: Address };
  contracts: Record<string, { address: Address }>;
};
const e2e = JSON.parse(readFileSync(resolve(REPO_DIR, "zk-holder/e2e/state/base-sepolia.json"), "utf8")) as {
  partners: Record<string, PartnerCredentials>;
  investors: Record<string, { wallet: { address: Address }; commitment?: string; callData?: unknown }>;
};
const secrets = [chainEnv.BASE_SEPOLIA_RPC_URL, chainEnv.PLATFORM_PRIVATE_KEY, chainEnv.DEPLOYER_PRIVATE_KEY, chainEnv.ETHERSCAN_API_KEY, process.env.ISSUER_PRIVATE_KEY]
  .filter((value): value is string => typeof value === "string" && value.length >= 8)
  .flatMap((value) => [value, value.replace(/^0x/, "")]);
const redact = (text: string) => secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    write(typeof chunk === "string" ? redact(chunk) : redact(Buffer.from(chunk).toString("utf8")), ...rest)) as typeof stream.write;
}
const stop = (error: unknown) => {
  process.stderr.write(`DETENIDO: ${error instanceof Error ? error.message.split("\n").slice(0, 4).join(" | ") : String(error)}\n`);
  process.exit(1);
};
process.on("unhandledRejection", stop);
process.on("uncaughtException", stop);

const ASSET_ID = BigInt(deployment.parameters.assetId);
const REGISTRY = deployment.contracts.credentialRegistry!.address;
const ATTESTOR = deployment.contracts.complianceAttestor!.address;
const X = deployment.parameters.deployer;
const transport = http(chainEnv.BASE_SEPOLIA_RPC_URL, { retryCount: 6, retryDelay: 500, timeout: 30_000 });
const client = createPublicClient({ chain: baseSepolia, transport }) as PublicClient;
const platform = privateKeyToAccount(chainEnv.PLATFORM_PRIVATE_KEY as `0x${string}`);
const platformWallet = createWalletClient({ account: platform, chain: baseSepolia, transport });
const basescan = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;

interface TxRow {
  label: string;
  hash: Hash;
  signer: string;
  gasUsed: string;
  feeWei: string;
  status: string;
}
interface S13State {
  baseline?: { X: string; Y: string; block: string };
  holders: StoredHolder[];
  steps: string[];
  txs: TxRow[];
}
const state: S13State = hasJson(STATE) ? readJson<S13State>(STATE) : { holders: [], steps: [], txs: [] };
const save = () => writeJson(STATE, state);
const done = (step: string) => state.steps.includes(step);
const complete = (step: string) => {
  state.steps.push(step);
  save();
};

async function balances() {
  return { X: await client.getBalance({ address: X }), Y: await client.getBalance({ address: platform.address }) };
}

async function spent(): Promise<bigint> {
  const now = await balances();
  return BigInt(state.baseline!.X) - now.X + (BigInt(state.baseline!.Y) - now.Y);
}

async function guard(next: string): Promise<void> {
  const total = await spent();
  if (total + MARGIN > BUDGET) throw new Error(`budget: spent ${formatEther(total)} ETH, next step "${next}" could exceed ${formatEther(BUDGET)} ETH`);
}

async function track(hash: Hash, label: string, signer: string): Promise<TxRow> {
  const existing = state.txs.find((tx) => tx.hash === hash);
  if (existing) return existing;
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: CONFIRMATIONS, timeout: 300_000 });
  const l1Fee = (receipt as { l1Fee?: bigint | null }).l1Fee ?? 0n;
  const row: TxRow = {
    label,
    hash,
    signer,
    gasUsed: receipt.gasUsed.toString(),
    feeWei: (receipt.gasUsed * receipt.effectiveGasPrice + l1Fee).toString(),
    status: receipt.status,
  };
  state.txs.push(row);
  save();
  line(`tx ${label} · ${signer} · ${row.status} · gas ${row.gasUsed} · ${formatEther(BigInt(row.feeWei))} ETH · ${basescan(hash)}`);
  return row;
}

async function invalidationAfter(publishHash: Hash): Promise<Hash | undefined> {
  const receipt = await client.getTransactionReceipt({ hash: publishHash });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const head = await client.getBlockNumber();
    const to = receipt.blockNumber + 9n < head ? receipt.blockNumber + 9n : head;
    const logs = await client.getLogs({
      address: REGISTRY,
      event: parseAbiItem("event CredentialRootInvalidated(uint256 indexed root)"),
      fromBlock: receipt.blockNumber,
      toBlock: to,
    });
    if (logs[0]) return logs[0].transactionHash!;
    await new Promise((done) => setTimeout(done, 2_000));
  }
  return undefined;
}

machine();
heading("0 · Comprobaciones previas");
const chainId = await client.getChainId();
if (chainId !== 84532) throw new Error(`the RPC is chain ${chainId}, not Base Sepolia`);
if (Number(process.env.CHAIN_ID) !== 84532) throw new Error("the service environment is not Base Sepolia");
if (platform.address !== deployment.parameters.platform) throw new Error("PLATFORM_PRIVATE_KEY is not Y");
line(`red ${chainId} (Base Sepolia) · registro ${REGISTRY} · atestador ${ATTESTOR} · activo ${ASSET_ID} · Y ${platform.address} · X ${X}`);
if (!state.baseline) {
  const start = await balances();
  state.baseline = { X: start.X.toString(), Y: start.Y.toString(), block: (await client.getBlockNumber()).toString() };
  save();
}
line(`saldos de partida: X ${formatEther(BigInt(state.baseline.X))} ETH · Y ${formatEther(BigInt(state.baseline.Y))} ETH · tope de gasto ${formatEther(BUDGET)} ETH`);
line(`precio del gas ${await client.getGasPrice()} wei · bloque ${await client.getBlockNumber()}`);

const service = await startService("s13", { DOTENV_CONFIG_PATH: ".env.testnet", API_PORT });
const platformApi = new StressClient(service.url, e2e.partners.platform!);
const bank = new StressClient(service.url, e2e.partners.bank!);
const operator = new StressClient(service.url, e2e.partners.operator!);
const audit = new StressClient(service.url, e2e.partners.audit!);
const domain = { chainId: 84532, credentialRegistry: REGISTRY };

try {
  heading(`1 · Lecturas contra la cadena pública (${READS} de cada, en serie)`);
  const A = e2e.investors.A!;
  const readRoutes: [string, StressClient, string][] = [
    ["GET /v1/compliance/assets/:asset/subjects/:A", bank, `/v1/compliance/assets/${ASSET_ID}/subjects/${A.wallet.address}`],
    ["GET /v1/credentials/:commitmentA", platformApi, `/v1/credentials/${A.commitment}`],
  ];
  for (const [title, who, path] of readRoutes) {
    const times: number[] = [];
    const statuses: Record<string, number> = {};
    for (let i = 0; i < READS; i += 1) {
      const reply = await who.get(path);
      times.push(reply.ms);
      statuses[reply.status] = (statuses[reply.status] ?? 0) + 1;
    }
    line(`${title}: ${formatSummary(summarize(times))} · ${JSON.stringify(statuses)}`);
  }
  const verifyTimes: number[] = [];
  const verdicts: Record<string, number> = {};
  for (let i = 0; i < 10; i += 1) {
    const reply = await bank.post("/v1/verifications", { proof: A.callData });
    verifyTimes.push(reply.ms);
    const key = `${reply.status} valid=${reply.body?.valid} ${reply.body?.rejectionCode ?? ""}`.trim();
    verdicts[key] = (verdicts[key] ?? 0) + 1;
  }
  line(`POST /v1/verifications (prueba ya presentada de A): ${formatSummary(summarize(verifyTimes))} · ${JSON.stringify(verdicts)}`);

  heading(`2 · ${HOLDERS} titulares nuevos: emisión en dos tiempos (Y paga cada publicación)`);
  const holders: Holder[] = state.holders.map(restoreHolder);
  while (holders.length < HOLDERS) {
    await guard("activation");
    const holder = await newHolder(170);
    const registered = await register(platformApi, holder);
    if (registered.status !== 201) throw new Error(`register answered ${registered.status} ${registered.body?.code}`);
    const activated = await activate(platformApi, holder, domain);
    if (activated.status !== 201) throw new Error(`activation answered ${activated.status} ${activated.body?.code}`);
    line(`activación ${holders.length + 1}: alta ${ms(registered.ms)} · activación ${ms(activated.ms)} · posición ${activated.body.leafIndex}`);
    await track(activated.body.txHash as Hash, `publishCredentialRoot (activación ${holders.length + 1})`, "Y vía zk-api");
    holders.push(holder);
    state.holders = holders.map(serializeHolder);
    save();
  }

  heading("3 · Prueba local de cada titular y attestFor presentado y pagado por Y");
  if (!done("attested")) {
    for (const [i, holder] of holders.entries()) {
      await guard("attestFor");
      const t0 = performance.now();
      const witness = await witnessFor(platformApi, holder, client, ATTESTOR, ASSET_ID);
      const callData = await groth16CallData(witness);
      const check = await bank.post("/v1/verifications", { proof: callData });
      line(`titular ${i + 1}: prueba en ${ms(performance.now() - t0)} · el banco la comprueba: ${check.status} valid=${check.body?.valid} ${check.body?.rejectionCode ?? ""}`);
      const { proof, signals } = attestorArguments(callData);
      const outcome = await presentForSubject({
        publicClient: client,
        walletClient: platformWallet,
        attestor: ATTESTOR,
        subject: holder.account.address,
        proof,
        signals,
        confirmations: CONFIRMATIONS,
      });
      if (outcome.status === "attested") await track(outcome.txHash, `attestFor (titular ${i + 1})`, "Y");
      else json(`titular ${i + 1}`, outcome);
    }
    complete("attested");
  }

  heading("4 · Limpieza: revokeAttestation (Y) y revocación de las credenciales cerrando la ventana (zk-api)");
  if (!done("attestations-revoked")) {
    for (const [i, holder] of holders.entries()) {
      const current = await client.readContract({ address: ATTESTOR, abi: complianceAttestorAbi, functionName: "attestationOf", args: [ASSET_ID, holder.account.address] });
      if (current.expiresAt === 0n) continue;
      await guard("revokeAttestation");
      const { request } = await client.simulateContract({
        account: platform,
        address: ATTESTOR,
        abi: complianceAttestorAbi,
        functionName: "revokeAttestation",
        args: [ASSET_ID, holder.account.address],
      });
      await track(await platformWallet.writeContract(request), `revokeAttestation (titular ${i + 1})`, "Y");
    }
    complete("attestations-revoked");
  }
  for (const [i, holder] of holders.entries()) {
    const step = `revoked-${i}`;
    if (done(step)) continue;
    await guard("revocation");
    const reply = await platformApi.post(`/v1/credentials/${holder.commitment}/revocation`, { closeRootWindow: true });
    if (reply.status !== 200) throw new Error(`revocation answered ${reply.status} ${reply.body?.code}`);
    line(`revocación ${i + 1}: ${ms(reply.ms)} · ventana cerrada ${reply.body.previousRootInvalidated}`);
    await track(reply.body.txHash as Hash, `publishCredentialRoot (revocación ${i + 1})`, "Y vía zk-api");
    if (reply.body.previousRootInvalidated) {
      const invalidation = await invalidationAfter(reply.body.txHash as Hash);
      if (invalidation) await track(invalidation, `invalidateCredentialRoot (revocación ${i + 1})`, "Y vía zk-api");
      else line("no se encontró la invalidación en los 10 bloques siguientes");
    }
    complete(step);
  }

  heading("5 · Reconstrucción, reconciliación e integridad (eth_getLogs en ventanas)");
  const credentials = await operator.post("/v1/issuer/state/rebuild");
  line(
    `credenciales: ${credentials.status} · matchesChain=${credentials.body?.matchesChain} · eventos ${credentials.body?.events} · hojas ${credentials.body?.leafCount} · faltan en BD ${credentials.body?.missingFromDatabase?.length} · faltan en cadena ${credentials.body?.missingFromChain?.length} · ${ms(credentials.ms)}`,
  );
  const asset = await operator.post(`/v1/issuer/assets/${ASSET_ID}/state/rebuild`);
  line(`jurisdicciones: ${asset.status} · matchesChain=${asset.body?.matchesChain} · ${ms(asset.ms)}`);
  const integrity = await audit.get("/v1/access-log/integrity");
  line(`registro de accesos: ${integrity.status} · intact=${integrity.body?.intact} · entradas ${integrity.body?.entries}`);
} finally {
  await releaseProver();
  await service.stop();
}

heading("6 · Gas frente a Hardhat y gasto");
const localPath = resolve(REPO_DIR, "zk-contracts/stress/out/gas.json");
const local = existsSync(localPath) ? (JSON.parse(readFileSync(localPath, "utf8")) as Record<string, number>) : {};
const groups: Record<string, string> = {
  publishCredentialRoot1: "publishCredentialRoot",
  invalidateCredentialRoot: "invalidateCredentialRoot",
  attestFor: "attestFor",
  revokeAttestation: "revokeAttestation",
};
for (const [key, prefix] of Object.entries(groups)) {
  const rows = state.txs.filter((tx) => tx.label.startsWith(prefix));
  if (rows.length === 0 || local[key] === undefined) continue;
  for (const row of rows) {
    const delta = (100 * (Number(row.gasUsed) - local[key]!)) / local[key]!;
    line(`${row.label}: Base Sepolia ${row.gasUsed} · Hardhat ${local[key]} · diferencia ${delta.toFixed(2)} %`);
  }
}
const end = await balances();
const spentX = BigInt(state.baseline!.X) - end.X;
const spentY = BigInt(state.baseline!.Y) - end.Y;
const fees = state.txs.reduce((sum, tx) => sum + BigInt(tx.feeWei), 0n);
line(`saldos finales: X ${formatEther(end.X)} ETH · Y ${formatEther(end.Y)} ETH`);
line(`gasto por saldo: X ${formatEther(spentX)} ETH · Y ${formatEther(spentY)} ETH · total ${formatEther(spentX + spentY)} ETH (tope ${formatEther(BUDGET)})`);
line(`suma de comisiones de las ${state.txs.length} transacciones registradas: ${formatEther(fees)} ETH`);
heading("Registro del servicio");
json("resumen", summarizeServiceLog(service.logPath));
process.exit(0);
