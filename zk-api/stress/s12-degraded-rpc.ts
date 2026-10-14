import "./lib/load-env.js";

import { leafEvents, issuerNonce, nodeClient } from "./lib/chain.js";
import { reconcile } from "./lib/checks.js";
import { StressClient, type PartnerCredentials, type Reply } from "./lib/client.js";
import { stressPrisma, tableCounts } from "./lib/db.js";
import { readJson, readLocalDeployment, requireStressStores } from "./lib/env.js";
import { activate, expectedCommitment, newHolder, register, type Holder } from "./lib/holder.js";
import { NO_FAULTS, RpcProxy, rpc } from "./lib/rpc-proxy.js";
import { startService, summarizeServiceLog } from "./lib/service.js";
import { formatSummary, heading, json, line, machine, summarize } from "./lib/stats.js";

const ACTIVATIONS = Number(process.env.STRESS_ACTIVATIONS ?? 50);
const CONCURRENCY = 5;
const PROXY_PORT = 8566;
const DEGRADED = {
  ...NO_FAULTS,
  rateLimited: 0.2,
  latencyMs: [20, 150] as [number, number],
  receiptDelayMs: 3_000,
  lostSendResponses: 0.1,
};

requireStressStores(process.env.DATABASE_URL!, process.env.REDIS_URL!);
machine();
const deployment = readLocalDeployment();
const partners = readJson<Record<string, PartnerCredentials>>("partners.json");
const domain = { chainId: deployment.chainId, credentialRegistry: deployment.credentialRegistry };
const node = nodeClient();
const fromBlock = BigInt(deployment.deploymentBlock);

await rpc(process.env.CHAIN_RPC_URL!, "evm_setIntervalMining", [1000]);
line("el nodo local produce además un bloque por segundo, como una red viva, para que la espera de recibos siga sondeando");
const proxy = new RpcProxy(process.env.CHAIN_RPC_URL!, PROXY_PORT, { ...DEGRADED });
await proxy.start();
json("fallos inyectados", DEGRADED);
const service = await startService("s12", { CHAIN_RPC_URL: proxy.url, CHAIN_RECEIPT_TIMEOUT_MS: "60000" });
const platform = new StressClient(service.url, partners.platform!);
const operator = new StressClient(service.url, partners.operator!);

async function snapshot() {
  return {
    nonce: await issuerNonce(node, deployment.issuer),
    events: (await leafEvents(node, deployment.credentialRegistry, fromBlock)).length,
    counts: await tableCounts(),
  };
}

async function registerMany(count: number): Promise<Holder[]> {
  const holders: Holder[] = [];
  for (let i = 0; i < count; i += 1) {
    const holder = await newHolder(170);
    const reply = await register(platform, holder);
    if (reply.status !== 201) throw new Error(`register answered ${reply.status}`);
    holders.push(holder);
  }
  return holders;
}

async function onChainButNotActive(holders: Holder[], replies: Reply[]) {
  const prisma = await stressPrisma();
  const events = await leafEvents(node, deployment.credentialRegistry, fromBlock);
  const issues: Record<string, unknown>[] = [];
  for (const [i, reply] of replies.entries()) {
    if (reply.status === 201) continue;
    const row = await prisma.credential.findUnique({ where: { id: holders[i]!.credentialId! } });
    const commitment = (await expectedCommitment(holders[i]!)).toString();
    const onChain = events.filter((e) => e.commitment === commitment);
    issues.push({ status: reply.status, code: reply.body?.code, dbStatus: row?.status, inTree: row?.inTree, leafEventsOnChain: onChain.length });
  }
  return issues;
}

heading(`${ACTIVATIONS} activaciones (concurrencia ${CONCURRENCY}) con RPC degradado`);
const before = await snapshot();
json("antes", before);
const holders = await registerMany(ACTIVATIONS);
const replies: Reply[] = new Array(ACTIVATIONS);
let index = 0;
const t0 = performance.now();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (index < holders.length) {
      const mine = index++;
      replies[mine] = await activate(platform, holders[mine]!, domain);
    }
  }),
);
const wall = (performance.now() - t0) / 1000;
const statuses: Record<string, number> = {};
for (const reply of replies) {
  const key = `${reply.status}${reply.status >= 400 ? ` ${reply.body?.code} · ${String(reply.body?.details?.reason ?? "").slice(0, 120)}` : ""}`;
  statuses[key] = (statuses[key] ?? 0) + 1;
}
json("estados", statuses);
line(`${wall.toFixed(1)} s · latencia ${formatSummary(summarize(replies.map((r) => r.ms)))}`);
json("peticiones al nodo por método", proxy.stats.requests);
json("fallos inyectados (recuento)", proxy.stats.injected);

const after = await snapshot();
json("después", after);
const succeeded = replies.filter((r) => r.status === 201).length;
const mined = after.nonce - before.nonce;
const newEvents = after.events - before.events;
line(`activaciones 201: ${succeeded} · transacciones minadas del emisor: ${mined} · eventos de hoja nuevos: ${newEvents} · credenciales activas nuevas en BD: ${after.counts.activeInTree - before.counts.activeInTree}`);
const indices = replies.filter((r) => r.status === 201).map((r) => r.body.leafIndex as number);
line(`posiciones asignadas ${indices.length}, distintas ${new Set(indices).size}`);
const issues = await onChainButNotActive(holders, replies);
if (issues.length) json("activaciones fallidas: estado en BD y en cadena", issues);

proxy.faults = { ...NO_FAULTS };
await reconcile(operator, "reconciliación tras la carga degradada (proxy sin fallos)");

heading("Un revert no se reintenta");
const [reverting] = await registerMany(1);
const estimatesBefore = proxy.stats.requests.eth_estimateGas ?? 0;
const sendsBefore = proxy.stats.requests.eth_sendRawTransaction ?? 0;
proxy.faults = { ...NO_FAULTS, revertNextEstimates: 1 };
const reverted = await activate(platform, reverting!, domain);
json("respuesta", { status: reverted.status, code: reverted.body?.code, revert: reverted.body?.details?.revert });
line(`eth_estimateGas enviados para esta activación: ${(proxy.stats.requests.eth_estimateGas ?? 0) - estimatesBefore} · eth_sendRawTransaction: ${(proxy.stats.requests.eth_sendRawTransaction ?? 0) - sendsBefore}`);
const row = await (await stressPrisma()).credential.findUnique({ where: { id: reverting!.credentialId! } });
json("credencial tras el revert", { status: row?.status, inTree: row?.inTree, commitment: row?.commitment, leafIndex: row?.leafIndex });
proxy.faults = { ...NO_FAULTS };
const retried = await activate(platform, reverting!, domain);
line(`reintento sin fallo: ${retried.status} · posición ${retried.body?.leafIndex}`);

heading("Respuesta perdida tras aceptar la transacción (eth_sendRawTransaction → 502 con la transacción ya en el nodo)");
const [lost] = await registerMany(1);
const nonceBeforeLost = await issuerNonce(node, deployment.issuer);
const eventsBeforeLost = (await leafEvents(node, deployment.credentialRegistry, fromBlock)).length;
proxy.faults = { ...NO_FAULTS, lostSendResponses: 1 };
const lostReply = await activate(platform, lost!, domain);
proxy.faults = { ...NO_FAULTS };
json("respuesta", { status: lostReply.status, code: lostReply.body?.code, reason: lostReply.body?.details?.reason, leafIndex: lostReply.body?.leafIndex });
const lostRow = await (await stressPrisma()).credential.findUnique({ where: { id: lost!.credentialId! } });
const lostCommitment = (await expectedCommitment(lost!)).toString();
line(`eventos en cadena con el compromiso de esta activación: ${(await leafEvents(node, deployment.credentialRegistry, fromBlock)).filter((e) => e.commitment === lostCommitment).length}`);
line(
  `transacciones minadas: ${(await issuerNonce(node, deployment.issuer)) - nonceBeforeLost} · eventos de hoja nuevos: ${(await leafEvents(node, deployment.credentialRegistry, fromBlock)).length - eventsBeforeLost} · estado en BD ${lostRow?.status} (inTree ${lostRow?.inTree})`,
);
await reconcile(operator, "reconciliación tras la respuesta perdida");

await service.stop();
await proxy.stop();
await rpc(process.env.CHAIN_RPC_URL!, "evm_setIntervalMining", [0]);
heading("Registro del servicio");
json("resumen", summarizeServiceLog(service.logPath));
process.exit(0);
