import type { Request } from "express";

import { apiError } from "../lib/errors.js";

/// Express types a path parameter as possibly repeated. Every parameter this API
/// declares appears once, so this narrows and refuses the shapes that cannot
/// occur rather than asserting them away. A parameter validation converted to a
/// number is read back as the text it arrived as.
export function param(req: Request, name: string): string {
  const value = optionalParam(req, name);
  if (value === null) {
    throw apiError.badRequest("missing_path_parameter", `the path parameter "${name}" is required`);
  }
  return value;
}

export function optionalParam(req: Request, name: string): string | null {
  const value: unknown = req.params[name];
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value : null;
}
