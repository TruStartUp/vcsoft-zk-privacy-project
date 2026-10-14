import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "dotenv";

import { API_DIR, ENV_FILE, STRESS_API_PORT, ensureOutDir } from "./env.js";
import { line, sleep } from "./stats.js";

export interface RunningService {
  url: string;
  port: number;
  pid: number;
  logPath: string;
  logName: string;
  stop(): Promise<void>;
  /// Resident memory of the service and the processes it started (tsx runs the server
  /// in a child of its own).
  rssMiB(): number;
}

/// Starts zk-api exactly as `npm start` does, against the stress environment file
/// plus any overrides, and waits for /health.
export async function startService(label: string, overrides: Record<string, string> = {}): Promise<RunningService> {
  const port = Number(overrides.API_PORT ?? STRESS_API_PORT);
  const logName = `service-${label}.log`;
  const logPath = resolve(ensureOutDir(), logName);
  const output = openSync(logPath, "w");
  const file = overrides.DOTENV_CONFIG_PATH ?? ENV_FILE;
  const fromFile = parse(readFileSync(resolve(API_DIR, file)));
  const child: ChildProcess = spawn(resolve(API_DIR, "node_modules/.bin/tsx"), ["src/server.ts"], {
    cwd: API_DIR,
    env: { ...process.env, ...fromFile, DOTENV_CONFIG_PATH: file, ...overrides, API_PORT: String(port) },
    stdio: ["ignore", output, output],
  });

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited) throw new Error(`zk-api (${label}) exited during start; see stress/out/${logName}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`zk-api (${label}) did not answer /health in 60 s`);
    await sleep(250);
  }
  line(`zk-api (${label}) escuchando en ${url} · pid ${child.pid}`);

  return {
    url,
    port,
    pid: child.pid!,
    logPath,
    logName,
    rssMiB() {
      try {
        const table = execFileSync("ps", ["-Ao", "pid=,ppid=,rss="], { encoding: "utf8" })
          .trim()
          .split("\n")
          .map((row) => row.trim().split(/\s+/).map(Number) as [number, number, number]);
        const tree = new Set([child.pid!]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const [pid, ppid] of table) if (tree.has(ppid) && !tree.has(pid)) (tree.add(pid), (grew = true));
        }
        return table.filter(([pid]) => tree.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0) / 1024;
      } catch {
        return Number.NaN;
      }
    },
    async stop() {
      if (exited) {
        closeSync(output);
        return;
      }
      const done = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      child.kill("SIGTERM");
      await Promise.race([done, sleep(30_000)]);
      if (!exited) child.kill("SIGKILL");
      closeSync(output);
    },
  };
}

export interface ServiceLogSummary {
  lines: number;
  byLevel: Record<string, number>;
  errors: Record<string, number>;
  statusCodes: Record<string, number>;
}

const LEVELS: Record<number, string> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };

/// Counts what the service itself logged: responses by status, and every error
/// message with its code, so a run cannot hide a 5xx or a dropped log entry.
export function summarizeServiceLog(logPath: string): ServiceLogSummary {
  const summary: ServiceLogSummary = { lines: 0, byLevel: {}, errors: {}, statusCodes: {} };
  for (const raw of readFileSync(logPath, "utf8").split("\n")) {
    if (!raw.startsWith("{")) continue;
    let entry: { level?: number; msg?: string; err?: { code?: string; message?: string; type?: string }; res?: { statusCode?: number } };
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    summary.lines += 1;
    const level = LEVELS[entry.level ?? 0] ?? String(entry.level);
    summary.byLevel[level] = (summary.byLevel[level] ?? 0) + 1;
    if (entry.res?.statusCode !== undefined) {
      const code = String(entry.res.statusCode);
      summary.statusCodes[code] = (summary.statusCodes[code] ?? 0) + 1;
    }
    if ((entry.level ?? 0) >= 50) {
      const reason = (entry.err?.code ?? entry.err?.message ?? entry.err?.type ?? "").split("\n")[0]!.slice(0, 160);
      const key = `${entry.msg ?? "?"}${reason ? ` · ${reason}` : ""}`;
      summary.errors[key] = (summary.errors[key] ?? 0) + 1;
    }
  }
  return summary;
}
