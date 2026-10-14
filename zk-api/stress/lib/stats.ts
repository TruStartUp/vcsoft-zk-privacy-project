import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";

export interface Summary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]!;
}

export function summarize(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    mean: sorted.length ? total / sorted.length : Number.NaN,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? Number.NaN,
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

export const ms = (value: number) => (Number.isFinite(value) ? `${value.toFixed(1)} ms` : "n/a");

export function formatSummary(summary: Summary): string {
  return `n=${summary.count} mean=${ms(summary.mean)} p50=${ms(summary.p50)} p95=${ms(summary.p95)} p99=${ms(summary.p99)} min=${ms(summary.min)} max=${ms(summary.max)}`;
}

/// Least-squares fit of y = a + b·x.
export function linearFit(points: [number, number][]): { intercept: number; slope: number; r2: number } {
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  const sxy = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const ssTot = points.reduce((s, [, y]) => s + (y - my) ** 2, 0);
  const ssRes = points.reduce((s, [x, y]) => s + (y - (intercept + slope * x)) ** 2, 0);
  return { intercept, slope, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

export function line(text = ""): void {
  process.stdout.write(`${text.length ? `[${new Date().toISOString()}] ` : ""}${text}\n`);
}

export function heading(title: string): void {
  line();
  line(`=== ${title}`);
}

export function json(label: string, value: unknown): void {
  line(`${label} ${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch {
    return "n/a";
  }
}

export function machine(): void {
  heading("Máquina");
  line(`CPU: ${run("sysctl", ["-n", "machdep.cpu.brand_string"])} · ${cpus().length} núcleos lógicos`);
  line(`Memoria: ${(totalmem() / 2 ** 30).toFixed(0)} GiB`);
  line(`Sistema: ${run("sw_vers", ["-productName"])} ${run("sw_vers", ["-productVersion"])} (${run("uname", ["-sr"])})`);
  line(`Node ${process.version} · Docker ${run("docker", ["--version"]).replace(/^Docker version /, "")}`);
}

export const sleep = (millis: number) => new Promise((done) => setTimeout(done, millis));

export function rss(): string {
  return `${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB`;
}
