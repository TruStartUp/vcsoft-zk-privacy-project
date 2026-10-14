import { Prisma } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";

import { apiError, isApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(apiError.notFound("route_not_found", `no route for ${req.method} ${req.path}`));
}

/// The two ways the database says it has no room for a request right now: no free
/// connection in the pool, or no transaction started in time. That is a capacity
/// refusal the caller can retry, not an internal error.
const SATURATION_CODES = new Set(["P2024", "P2028"]);

function saturated(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && SATURATION_CODES.has(error.code);
}

/// A response never invents a value it could not compute: an error carries its
/// snake_case code and stops there, so a caller can tell "not compliant" apart
/// from "we could not reach the chain".
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (saturated(error)) {
    logger.warn({ code: (error as Prisma.PrismaClientKnownRequestError).code, path: req.originalUrl }, "database saturated");
    error = apiError.serviceUnavailable("service_busy", "the service is at capacity; retry after the interval given", 2, {
      reason: "database_saturated",
    });
  }
  if (isApiError(error)) {
    if (error.output.statusCode >= 500 && error.output.statusCode !== 503) {
      logger.error({ err: error, path: req.originalUrl }, "request failed");
    } else {
      logger.warn({ code: (error.output.payload as { code?: string }).code, path: req.originalUrl }, "request refused");
    }
    for (const [name, value] of Object.entries(error.output.headers)) res.setHeader(name, String(value));
    res.status(error.output.statusCode).json(error.output.payload);
    return;
  }

  logger.error({ err: error, path: req.originalUrl }, "unhandled failure");
  const wrapped = apiError.internal("internal_error", "the request could not be completed");
  res.status(wrapped.output.statusCode).json(wrapped.output.payload);
}
