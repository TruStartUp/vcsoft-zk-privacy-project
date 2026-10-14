import type { NextFunction, Request, Response } from "express";

import { logger } from "../lib/logger.js";
import { recordAccessBatch, type AccessRecord } from "../services/access-log.service.js";

const BATCH = 500;
const ATTEMPTS = 5;
const pending: AccessRecord[] = [];
let draining: Promise<void> | null = null;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/// One writer per process, appending whatever has queued up in a single chained
/// insert. Each request appending on its own held a pooled connection while it waited
/// for the log's lock, and under load those waits used up the pool and entries were
/// dropped. A batch that fails is retried before it is given up and logged.
async function drain(): Promise<void> {
  while (pending.length > 0) {
    const batch = pending.splice(0, BATCH);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await recordAccessBatch(batch);
        break;
      } catch (error) {
        if (attempt >= ATTEMPTS) {
          logger.error({ err: error, entries: batch.length }, "access log entries could not be appended");
          break;
        }
        await pause(100 * 2 ** attempt);
      }
    }
  }
  draining = null;
}

function append(record: AccessRecord): void {
  pending.push(record);
  draining ??= drain();
}

/// Runs `record` once, when the response is sent or when the connection closes
/// first. A caller that hangs up mid-request still had it processed -- a verification
/// stored, a decision taken -- so the entry is written anyway, as `aborted`.
function onceSettled(res: Response, record: (aborted: boolean) => void): void {
  let done = false;
  const settle = (aborted: boolean) => {
    if (done) return;
    done = true;
    record(aborted);
  };
  res.on("finish", () => settle(false));
  res.on("close", () => settle(!res.writableFinished));
}

const ABORTED_STATUS = 499;

/// The log is written after the response is on the wire, so a slow append never
/// becomes latency the partner pays for. Callers that need the entry to exist --
/// tests, and the shutdown path -- wait on this.
export async function flushAccessLog(): Promise<void> {
  while (draining) await draining;
}

/// Every authenticated request lands in the append-only log, whatever its
/// outcome: a refused disclosure is exactly as interesting to an auditor as a
/// granted one, and a run of refusals is what an intrusion looks like.
export function logAccess(resourceType: string, resourceId?: (req: Request) => string | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    req.accessLogged = true;
    onceSettled(res, (aborted) => {
      const partner = req.partner;
      append({
        partnerId: partner?.id ?? null,
        partnerKey: partner?.partnerKey ?? "anonymous",
        actorRef: req.actorRef ?? null,
        method: req.method,
        path: req.originalUrl,
        scope: req.grantedScope ?? null,
        resourceType,
        resourceId: req.accessResource?.id ?? resourceId?.(req) ?? null,
        outcome: aborted ? "aborted" : res.statusCode < 400 ? "granted" : "refused",
        statusCode: aborted ? ABORTED_STATUS : res.statusCode,
        requestDigest: req.requestDigest ?? "",
        occurredAt: new Date(),
      });
    });
    next();
  };
}

/// Requests that never reach a route -- a bad signature, an expired window, an
/// unknown path -- would otherwise leave no trace, and those are exactly the
/// ones an auditor looks for. Mounted before authentication, it records only
/// what no route logger already covered.
export function logUnauthenticated(req: Request, res: Response, next: NextFunction): void {
  onceSettled(res, (aborted) => {
    if (req.accessLogged) return;
    append({
      partnerId: null,
      partnerKey: typeof req.headers["x-partner-key"] === "string" ? req.headers["x-partner-key"] : "anonymous",
      actorRef: null,
      method: req.method,
      path: req.originalUrl,
      scope: null,
      resourceType: "authentication",
      resourceId: null,
      outcome: aborted ? "aborted" : res.statusCode < 400 ? "granted" : "refused",
      statusCode: aborted ? ABORTED_STATUS : res.statusCode,
      requestDigest: req.requestDigest ?? "",
      occurredAt: new Date(),
    });
  });
  next();
}
