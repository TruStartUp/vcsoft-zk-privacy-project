import autocannon from "autocannon";

import { signedHeaders, type PartnerCredentials } from "./client.js";
import { formatSummary, json, line, summarize, type Summary } from "./stats.js";

export interface LoadOptions {
  url: string;
  title: string;
  connections: number;
  durationSeconds: number;
  method: "GET" | "POST";
  path: () => string;
  body?: () => unknown;
  credentials: PartnerCredentials;
  inspect?: (status: number, body: string) => void;
}

export interface LoadResult {
  title: string;
  connections: number;
  durationSeconds: number;
  requests: number;
  rps: number;
  latency: Summary;
  statuses: Record<string, number>;
  errors: number;
  timeouts: number;
}

/// Drives one route at a fixed concurrency for a fixed time. Every request is signed
/// with a fresh nonce on the way out, exactly as a partner would, and every response
/// time is kept so the percentiles are exact rather than read off a histogram.
export async function runLoad(options: LoadOptions): Promise<LoadResult> {
  const times: number[] = [];
  const statuses: Record<string, number> = {};

  const instance = autocannon({
    url: options.url,
    connections: options.connections,
    duration: options.durationSeconds,
    timeout: 60,
    requests: [
      {
        method: options.method,
        setupRequest: (request: { path: string; headers: Record<string, string>; body?: string }) => {
          const path = options.path();
          const raw = options.body ? Buffer.from(JSON.stringify(options.body()), "utf8") : Buffer.alloc(0);
          request.path = path;
          request.headers = signedHeaders(options.credentials, options.method, path, raw);
          if (raw.length > 0) request.body = raw.toString("utf8");
          else delete request.body;
          return request;
        },
        onResponse: options.inspect ? (status: number, body: string) => options.inspect!(status, body) : undefined,
      },
    ],
  });

  instance.on("response", (_client: unknown, statusCode: number, _bytes: number, responseTime: number) => {
    times.push(responseTime);
    statuses[String(statusCode)] = (statuses[String(statusCode)] ?? 0) + 1;
  });

  const result = await instance;
  const latency = summarize(times);
  const outcome: LoadResult = {
    title: options.title,
    connections: options.connections,
    durationSeconds: options.durationSeconds,
    requests: times.length,
    rps: times.length / options.durationSeconds,
    latency,
    statuses,
    errors: result.errors,
    timeouts: result.timeouts,
  };
  line(
    `${options.title} · c=${options.connections} · ${options.durationSeconds} s · ${outcome.requests} respuestas · ${outcome.rps.toFixed(1)} rps · ${formatSummary(latency)}`,
  );
  json("  estados", statuses);
  line(`  errores de conexión ${result.errors} · tiempos agotados ${result.timeouts}`);
  return outcome;
}
