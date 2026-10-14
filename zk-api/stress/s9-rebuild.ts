import "./lib/load-env.js";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createWalletClient, http, type Address, type Hex, type Transport } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { nodeClient } from "./lib/chain.js";
import { LOCAL_RPC_URL, REPO_DIR, requireStressStores } from "./lib/env.js";
import { NO_FAULTS, RpcProxy, rpc } from "./lib/rpc-proxy.js";
import { heading, json, line, machine, ms } from "./lib/stats.js";

const TOTAL_LEAVES = Number(process.env.STRESS_LEAVES ?? 10_000);
const CHECKPOINT = 1_000;
const PER_TX = 100;
const GAP_BLOCKS = 99;
const RANGES = [200, 2_000, 10_000];
const CAPPED_RANGE = 2_000;
const PROVIDER_CAP = 10;
// Hardhat's public development mnemonic, account #2: a registry of its own, so the
// service's issuer nonce is untouched.
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

requireStressStores(process.env.DATABASE_URL!, process.env.REDIS_URL!);
machine();
const node = nodeClient();
const owner = mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: 2 });
const wallet = createWalletClient({ account: owner, transport: http(LOCAL_RPC_URL) });
const artifact = JSON.parse(
  readFileSync(resolve(REPO_DIR, "zk-contracts/artifacts/contracts/CredentialRegistry.sol/CredentialRegistry.json"), "utf8"),
) as { abi: unknown[]; bytecode: Hex };

heading("Registro propio para la reconstrucción");
const deployHash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [owner.address, 900n], chain: null });
const deployed = await node.waitForTransactionReceipt({ hash: deployHash });
const registry = deployed.contractAddress as Address;
const deploymentBlock = deployed.blockNumber;
const issuerRole = (await node.readContract({ address: registry, abi: artifact.abi, functionName: "ISSUER_ROLE" })) as Hex;
await node.waitForTransactionReceipt({
  hash: await wallet.writeContract({ address: registry, abi: artifact.abi, functionName: "grantRole", args: [issuerRole, owner.address], chain: null }),
});
line(`registro ${registry} en el bloque ${deploymentBlock}`);

process.env.CREDENTIAL_REGISTRY_ADDRESS = registry;
process.env.REGISTRY_DEPLOYMENT_BLOCK = String(deploymentBlock);
const { SparseMerkleTree } = await import("../src/lib/merkle.js");
const { poseidonHash } = await import("../src/lib/poseidon.js");
const { CREDENTIAL_TREE_DEPTH } = await import("../src/lib/field.js");
const { configureChain } = await import("../src/lib/chain.js");
const { rebuildCredentialTreeFromChain } = await import("../src/services/tree.service.js");

const hash = await poseidonHash();
const tree = new SparseMerkleTree(CREDENTIAL_TREE_DEPTH, hash);
let nextIndex = 0;
let transactions = 0;
let removals = 0;

async function publish(updates: { leafIndex: bigint; commitment: bigint; inserted: boolean }[]) {
  const txHash = await wallet.writeContract({
    address: registry,
    abi: artifact.abi,
    functionName: "publishCredentialRoot",
    args: [tree.root(), updates],
    chain: null,
  });
  const receipt = await node.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("publication reverted");
  transactions += 1;
  await rpc(LOCAL_RPC_URL, "hardhat_mine", [`0x${GAP_BLOCKS.toString(16)}`]);
}

async function grow(target: number) {
  while (nextIndex < target) {
    const updates: { leafIndex: bigint; commitment: bigint; inserted: boolean }[] = [];
    for (let i = 0; i < PER_TX && nextIndex < target; i += 1, nextIndex += 1) {
      const commitment = hash(BigInt(nextIndex) + 1n, 170n, 2_000_000_000n);
      tree.setLeaf(nextIndex, commitment);
      updates.push({ leafIndex: BigInt(nextIndex), commitment, inserted: true });
    }
    if (transactions % 10 === 9) {
      for (let k = 0; k < 5; k += 1) {
        const index = nextIndex - 1 - k * 7;
        const commitment = tree.leafAt(index)!;
        tree.clearLeaf(index);
        updates.push({ leafIndex: BigInt(index), commitment, inserted: false });
        removals += 1;
      }
    }
    await publish(updates);
  }
}

function countingTransport(url: string, counts: Record<string, number>): Transport {
  return ((parameters: Parameters<Transport>[0]) => {
    const inner = http(url)(parameters);
    return {
      ...inner,
      request: (async (args: { method: string }, options?: unknown) => {
        counts[args.method] = (counts[args.method] ?? 0) + 1;
        return inner.request(args as never, options as never);
      }) as typeof inner.request,
    };
  }) as Transport;
}

async function rebuildWith(label: string, url: string, logBlockRange: number) {
  const counts: Record<string, number> = {};
  configureChain({ transport: countingTransport(url, counts), settings: { logBlockRange } });
  const t0 = performance.now();
  const { report } = await rebuildCredentialTreeFromChain();
  const elapsed = performance.now() - t0;
  const head = await node.getBlockNumber();
  line(
    `${label}: ${ms(elapsed)} · eth_getLogs ${counts.eth_getLogs ?? 0} · eventos ${report.events} · hojas ${report.leafCount} · matchesChain=${report.matchesChain} · raíz igual a la del árbol en memoria=${report.replayedRoot === tree.root().toString()} · bloques recorridos ${head - deploymentBlock}`,
  );
  return { label, elapsed, getLogs: counts.eth_getLogs ?? 0, ...report };
}

const results: unknown[] = [];
for (const target of [CHECKPOINT, TOTAL_LEAVES]) {
  heading(`Publicación hasta ${target} hojas (${PER_TX} cambios por transacción, ${GAP_BLOCKS} bloques vacíos entre transacciones)`);
  const t0 = performance.now();
  await grow(target);
  line(`${transactions} transacciones, ${removals} retiradas intercaladas, ${tree.leafCount} hojas vivas, ${ms(performance.now() - t0)}`);

  heading(`Reconstrucción desde los eventos con ${tree.leafCount} hojas`);
  for (const range of RANGES) results.push(await rebuildWith(`CHAIN_LOG_BLOCK_RANGE=${range}`, LOCAL_RPC_URL, range));

  const proxy = new RpcProxy(LOCAL_RPC_URL, 8567, { ...NO_FAULTS, logRangeCap: PROVIDER_CAP });
  await proxy.start();
  results.push(await rebuildWith(`proveedor limitado a ${PROVIDER_CAP} bloques, CHAIN_LOG_BLOCK_RANGE=${CAPPED_RANGE}`, proxy.url, CAPPED_RANGE));
  results.push(await rebuildWith(`proveedor limitado a ${PROVIDER_CAP} bloques, CHAIN_LOG_BLOCK_RANGE=${PROVIDER_CAP}`, proxy.url, PROVIDER_CAP));
  json("rechazos por rango del proveedor", proxy.stats.injected);
  await proxy.stop();
}

heading("Resumen S9");
for (const r of results as { label: string; elapsed: number; getLogs: number; leafCount: number; matchesChain: boolean }[]) {
  line(`${r.leafCount} hojas · ${r.label}: ${ms(r.elapsed)} · ${r.getLogs} eth_getLogs · matchesChain=${r.matchesChain}`);
}
process.exit(0);
