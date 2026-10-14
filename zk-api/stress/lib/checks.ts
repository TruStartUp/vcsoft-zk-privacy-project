import type { StressClient } from "./client.js";
import { json, line, ms } from "./stats.js";

export interface Reconciliation {
  matchesChain: boolean;
  events: number;
  leafCount: number;
  missingFromDatabase: string[];
  missingFromChain: string[];
  throughBlock: string;
}

export async function reconcile(operator: StressClient, label: string): Promise<Reconciliation> {
  const reply = await operator.post<Reconciliation>("/v1/issuer/state/rebuild");
  if (reply.status !== 200) {
    json(`${label}: la reconstrucción respondió ${reply.status}`, reply.body);
    throw new Error(`rebuild answered ${reply.status}`);
  }
  const body = reply.body;
  line(
    `${label}: matchesChain=${body.matchesChain} · eventos ${body.events} · hojas ${body.leafCount} · faltan en BD ${body.missingFromDatabase.length} · faltan en cadena ${body.missingFromChain.length} · ${ms(reply.ms)}`,
  );
  return body;
}

export async function integrity(audit: StressClient, label: string) {
  const reply = await audit.get<{ intact: boolean; entries: number; checked: number; brokenAtSequence: string | null; reason: string | null }>(
    "/v1/access-log/integrity",
  );
  line(`${label}: ${reply.status} · intact=${reply.body?.intact} · entradas ${reply.body?.entries} · comprobadas ${reply.body?.checked} · rotura ${reply.body?.brokenAtSequence ?? "ninguna"} · ${ms(reply.ms)}`);
  return reply;
}

/// Every credential publication must name the one before it as the root it replaced,
/// in block order: a fork or a skipped root shows up as a break here.
export async function rootChain(): Promise<{ publications: number; breaks: number; distinctTx: number }> {
  const { prisma } = await import("../../src/lib/prisma.js");
  const rows = await prisma.rootPublication.findMany({
    where: { kind: "CREDENTIAL" },
    orderBy: [{ blockNumber: "asc" }],
    select: { root: true, previousRoot: true, txHash: true, blockNumber: true },
  });
  let breaks = 0;
  for (let i = 1; i < rows.length; i += 1) if (rows[i]!.previousRoot !== rows[i - 1]!.root) breaks += 1;
  const blocks = new Set(rows.map((r) => String(r.blockNumber)));
  line(`publicaciones de raíz de credenciales: ${rows.length} · rupturas de la cadena de raíces ${breaks} · transacciones distintas ${new Set(rows.map((r) => r.txHash)).size} · bloques distintos ${blocks.size}`);
  return { publications: rows.length, breaks, distinctTx: new Set(rows.map((r) => r.txHash)).size };
}
