import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { sleep } from "./stats.js";

export interface Faults {
  /// Share of requests answered 429 without reaching the node.
  rateLimited: number;
  /// Extra latency added to every request, uniform in [min, max].
  latencyMs: [number, number];
  /// A receipt is reported missing until this long after its first lookup.
  receiptDelayMs: number;
  /// Share of eth_sendRawTransaction that reach the node and lose their answer (502).
  /// Only the first submission of a given transaction can lose it; a resend gets the
  /// node's own answer.
  lostSendResponses: number;
  /// Largest eth_getLogs span the node accepts; 0 for no limit.
  logRangeCap: number;
  /// Answer the next N eth_estimateGas with an execution revert.
  revertNextEstimates: number;
}

export const NO_FAULTS: Faults = {
  rateLimited: 0,
  latencyMs: [0, 0],
  receiptDelayMs: 0,
  lostSendResponses: 0,
  logRangeCap: 0,
  revertNextEstimates: 0,
};

interface RpcRequest {
  id: number | string;
  method: string;
  params?: unknown[];
}

export interface ProxyStats {
  requests: Record<string, number>;
  injected: Record<string, number>;
}

/// Sits between the service and the node and misbehaves on purpose, the way a
/// public provider does: rate limits, latency, receipts that lag, answers lost after
/// the node accepted the transaction, capped log ranges and scripted reverts.
export class RpcProxy {
  readonly stats: ProxyStats = { requests: {}, injected: {} };
  private server?: Server;
  private readonly firstReceiptLookup = new Map<string, number>();
  private readonly submitted = new Set<string>();

  constructor(
    private readonly upstream: string,
    readonly port: number,
    public faults: Faults = NO_FAULTS,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private count(bucket: Record<string, number>, key: string): void {
    bucket[key] = (bucket[key] ?? 0) + 1;
  }

  private async forward(body: string): Promise<{ status: number; text: string }> {
    const response = await fetch(this.upstream, { method: "POST", headers: { "content-type": "application/json" }, body });
    return { status: response.status, text: await response.text() };
  }

  private reply(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const parsed = JSON.parse(raw) as RpcRequest | RpcRequest[];
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    for (const call of calls) this.count(this.stats.requests, call.method);

    const [min, max] = this.faults.latencyMs;
    if (max > 0) await sleep(min + Math.random() * (max - min));

    if (Math.random() < this.faults.rateLimited) {
      this.count(this.stats.injected, "429");
      this.reply(res, 429, { jsonrpc: "2.0", id: calls[0]!.id, error: { code: 429, message: "Too Many Requests" } });
      return;
    }

    let firstSubmission = false;
    if (!Array.isArray(parsed)) {
      const call = parsed;
      if (call.method === "eth_estimateGas" && this.faults.revertNextEstimates > 0) {
        this.faults.revertNextEstimates -= 1;
        this.count(this.stats.injected, "revert");
        this.reply(res, 200, { jsonrpc: "2.0", id: call.id, error: { code: 3, message: "execution reverted", data: "0x" } });
        return;
      }
      if (call.method === "eth_getLogs" && this.faults.logRangeCap > 0) {
        const filter = (call.params?.[0] ?? {}) as { fromBlock?: string; toBlock?: string };
        const span = Number(BigInt(filter.toBlock ?? "0x0") - BigInt(filter.fromBlock ?? "0x0")) + 1;
        if (span > this.faults.logRangeCap) {
          this.count(this.stats.injected, "logRange");
          this.reply(res, 200, {
            jsonrpc: "2.0",
            id: call.id,
            error: { code: -32600, message: `You can make eth_getLogs requests with up to a ${this.faults.logRangeCap} block range.` },
          });
          return;
        }
      }
      if (call.method === "eth_getTransactionReceipt" && this.faults.receiptDelayMs > 0) {
        const hash = String(call.params?.[0]);
        const first = this.firstReceiptLookup.get(hash) ?? Date.now();
        this.firstReceiptLookup.set(hash, first);
        if (Date.now() - first < this.faults.receiptDelayMs) {
          this.count(this.stats.injected, "receiptDelayed");
          this.reply(res, 200, { jsonrpc: "2.0", id: call.id, result: null });
          return;
        }
      }
      firstSubmission = call.method === "eth_sendRawTransaction" && !this.submitted.has(String(call.params?.[0]));
      if (call.method === "eth_sendRawTransaction") this.submitted.add(String(call.params?.[0]));
      if (firstSubmission && Math.random() < this.faults.lostSendResponses) {
        const upstream = await this.forward(raw);
        this.count(this.stats.injected, "lostSendResponse");
        this.count(this.stats.injected, `lostSendResponse:${upstream.text.includes('"error"') ? "nodeRefused" : "nodeAccepted"}`);
        this.reply(res, 502, "Bad Gateway");
        return;
      }
    }

    const upstream = await this.forward(raw);
    if (!Array.isArray(parsed) && parsed.method === "eth_sendRawTransaction" && !firstSubmission && upstream.text.includes('"error"')) {
      this.count(this.stats.injected, `resendAnswer:${(JSON.parse(upstream.text) as { error: { message: string } }).error.message.slice(0, 80)}`);
    }
    this.reply(res, upstream.status, upstream.text);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.count(this.stats.injected, "proxyError");
        this.reply(res, 502, { error: String(error) });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, "127.0.0.1", () => resolve()));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}
