import type { NextFunction, Request, Response } from "express";
import type Joi from "joi";

import { apiError } from "../lib/errors.js";

type Source = "body" | "query" | "params";

/// Validation is the outermost layer of every route: nothing reaches a service
/// without having been shaped, and a rejected request never touches the chain or
/// the database.
export function validate(schema: Joi.Schema, source: Source = "body") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // A request without a body reaches here as undefined; it is validated as an empty
    // object so that optional bodies take their defaults and required fields are named.
    const input = source === "body" ? (req.body ?? {}) : req[source];
    const { value, error } = schema.validate(input, { abortEarly: false, convert: true, stripUnknown: true });
    if (error) {
      throw apiError.badRequest("validation_failed", "the request did not match the contract", {
        source,
        issues: error.details.map((detail) => ({ path: detail.path.join("."), message: detail.message })),
      });
    }
    if (source === "body") req.body = value;
    else Object.defineProperty(req, source, { value, writable: true, configurable: true });
    next();
  };
}
