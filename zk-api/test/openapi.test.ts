import { validate } from "@readme/openapi-parser";
import type { Express } from "express";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import supertest from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { createApp } from "../src/app.js";
import { OPENAPI_DOCUMENT_PATH } from "../src/routes/docs.routes.js";
import { REJECTION_CODES } from "../src/services/proof-verification.service.js";
import { DISCLOSURE_SCOPES } from "../src/services/disclosure.service.js";
import { SCOPES } from "../src/services/partner.service.js";

/// The specification is only worth anything if it cannot quietly stop being true.
///
/// So it is not read here as prose. The application is built, its router is walked, and
/// the document is held against it: a route the application serves and the document does
/// not describe fails, a documented route the application does not serve fails, an
/// operation that claims a scope other than the one the route enforces fails, and an
/// error code the source can emit that the catalog does not list fails.
///
/// Every one of those is a way a specification rots without anybody noticing, and every
/// one of them is red here instead.

const SOURCE_ROOT = resolve(import.meta.dirname, "../src");

interface Operation {
  path: string;
  method: string;
  operation: Record<string, unknown>;
}

interface RouteLayer {
  route: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  match(path: string): boolean;
  path?: string;
}

interface RouterLayer {
  name: string;
  handle: { stack: unknown[] };
  match(path: string): boolean;
  path?: string;
}

type Layer = RouteLayer | RouterLayer;

const isRouteLayer = (layer: Layer): layer is RouteLayer => "route" in layer && Boolean(layer.route);
const isRouterLayer = (layer: Layer): layer is RouterLayer =>
  !isRouteLayer(layer) && typeof (layer as RouterLayer).handle === "function" &&
  Array.isArray(((layer as RouterLayer).handle as unknown as { stack?: unknown[] }).stack);

function stackOf(app: Express): Layer[] {
  const router = (app as unknown as { router?: { stack: Layer[] } }).router;
  if (!router) throw new Error("this version of express does not expose its router");
  return router.stack;
}

/// Every terminal route the application registers, identified by the layer object itself
/// so that two routes with the same declared path are still two routes.
function registeredRoutes(stack: Layer[], found: { layer: RouteLayer; method: string }[] = []) {
  for (const layer of stack) {
    if (isRouteLayer(layer)) {
      for (const method of Object.keys(layer.route.methods)) found.push({ layer, method });
    } else if (isRouterLayer(layer)) {
      registeredRoutes(layer.handle.stack as Layer[], found);
    }
  }
  return found;
}

/// Express's own dispatch, replayed: match in registration order, and for a mounted
/// router strip the prefix it consumed and carry on inside it. Mount prefixes are never
/// guessed, they are read off the layer that just matched.
function resolveRoute(stack: Layer[], path: string, method: string): RouteLayer | null {
  for (const layer of stack) {
    if (isRouteLayer(layer)) {
      if (layer.match(path) && layer.route.methods[method]) return layer;
    } else if (isRouterLayer(layer)) {
      if (!layer.match(path)) continue;
      const consumed = layer.path ?? "";
      const inner = resolveRoute(layer.handle.stack as Layer[], path.slice(consumed.length) || "/", method);
      if (inner) return inner;
    }
  }
  return null;
}

/// A concrete path the router can match, with every template parameter filled in by
/// something that is a single segment and nothing else.
const concrete = (path: string) => path.replace(/\{[^}]+\}/g, "1");

async function sourceFiles(directory: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, found);
    else if (extname(entry.name) === ".ts") found.push(full);
  }
  return found;
}

const STATUS_OF_KIND: Record<string, number> = {
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  unprocessable: 422,
  tooManyRequests: 429,
  failedDependency: 424,
  internal: 500,
  serviceUnavailable: 503,
};

/// Every error the source can raise, read off the calls themselves. `apiError` is the
/// only way this service produces one, so this is the whole population.
async function emittedErrorCodes(): Promise<Map<string, Set<number>>> {
  const emitted = new Map<string, Set<number>>();
  for (const file of await sourceFiles(SOURCE_ROOT)) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/apiError\.(\w+)\(\s*"([a-z_]+)"/g)) {
      const status = STATUS_OF_KIND[match[1]!];
      expect(status, `apiError.${match[1]} in ${file} is not a known error kind`).toBeDefined();
      const statuses = emitted.get(match[2]!) ?? new Set<number>();
      statuses.add(status!);
      emitted.set(match[2]!, statuses);
    }
  }
  return emitted;
}

let app: Express;
let raw: string;
let document: Record<string, any>;
let operations: Operation[];

beforeAll(async () => {
  app = createApp();
  raw = await readFile(OPENAPI_DOCUMENT_PATH, "utf8");
  document = parse(raw) as Record<string, any>;
  operations = Object.entries(document.paths as Record<string, Record<string, unknown>>).flatMap(
    ([path, item]) =>
      Object.entries(item)
        .filter(([method]) => ["get", "post", "put", "patch", "delete", "head", "options"].includes(method))
        .map(([method, operation]) => ({ path, method, operation: operation as Record<string, unknown> })),
  );
});

describe("the document itself", () => {
  it("is a valid OpenAPI 3.1 document", async () => {
    const result = await validate(structuredClone(document) as never);
    const errors = result.valid ? [] : result.errors;
    expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it("gives every operation an identifier of its own", () => {
    const ids = operations.map(({ operation }) => operation.operationId as string);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the document against the routes the application actually serves", () => {
  it("describes every route the application registers", () => {
    const registered = registeredRoutes(stackOf(app));
    const covered = new Set<string>();

    for (const { path, method } of operations) {
      const hit = resolveRoute(stackOf(app), concrete(path), method);
      expect(hit, `the document describes ${method.toUpperCase()} ${path}, which no route serves`).not.toBeNull();
      covered.add(`${registered.findIndex((entry) => entry.layer === hit && entry.method === method)}`);
    }

    const undocumented = registered
      .map((entry, index) => ({ ...entry, index }))
      .filter((entry) => !covered.has(String(entry.index)))
      .map((entry) => `${entry.method.toUpperCase()} …${entry.layer.route.path}`);

    expect(undocumented, `these routes are registered and not documented: ${undocumented.join(", ")}`).toHaveLength(0);
    expect(operations).toHaveLength(registered.length);
  });

  it("declares, for each operation, the scope the route enforces", () => {
    for (const { path, method, operation } of operations) {
      const hit = resolveRoute(stackOf(app), concrete(path), method);
      const guard = hit!.route.stack
        .map((entry) => entry.handle as { requiredScope?: string })
        .find((handler) => typeof handler.requiredScope === "string");

      expect(operation["x-required-scope"], `${method.toUpperCase()} ${path}`).toBe(guard?.requiredScope);
    }
  });

  it("leaves the public routes public, and only those", () => {
    const publicPaths = operations
      .filter(({ operation }) => Array.isArray(operation.security) && operation.security.length === 0)
      .map(({ path }) => path);

    expect(publicPaths.sort()).toEqual(["/api/docs", "/api/openapi.yaml", "/health"]);
    for (const { operation } of operations.filter(({ path }) => publicPaths.includes(path))) {
      expect(operation["x-required-scope"]).toBeUndefined();
    }
  });
});

describe("the catalogs against what the code can produce", () => {
  it("lists every error code the source can emit, and invents none", async () => {
    const emitted = await emittedErrorCodes();
    const catalogued = new Set((document.components.schemas.ErrorCode.enum as string[]));

    const missing = [...emitted.keys()].filter((code) => !catalogued.has(code)).sort();
    const phantom = [...catalogued].filter((code) => !emitted.has(code)).sort();

    expect(missing, `emitted and not catalogued: ${missing.join(", ")}`).toHaveLength(0);
    expect(phantom, `catalogued and never emitted: ${phantom.join(", ")}`).toHaveLength(0);
  });

  it("gives every code the status the code actually returns it under", async () => {
    const emitted = await emittedErrorCodes();
    const catalog = document["x-error-catalog"] as { code: string; status: number; meaning: string }[];

    expect(catalog.map((entry) => entry.code).sort()).toEqual([...emitted.keys()].sort());
    for (const entry of catalog) {
      expect([...emitted.get(entry.code)!], entry.code).toEqual([entry.status]);
      expect(entry.meaning.length, entry.code).toBeGreaterThan(20);
    }
  });

  it("lists every reason a proof can be refused", () => {
    expect(document.components.schemas.RejectionCode.enum).toEqual([...REJECTION_CODES]);
  });

  it("lists the scopes a partner can hold, and the attributes a disclosure can name", () => {
    expect(document.components.schemas.Scope.enum).toEqual([...SCOPES]);
    expect(document.components.schemas.DisclosureScope.enum).toEqual([...DISCLOSURE_SCOPES]);
  });
});

describe("serving it", () => {
  it("hands over the document with no credentials at all", async () => {
    const response = await supertest(app).get("/api/openapi.yaml");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/yaml");
    expect(response.text).toBe(raw);
  });

  it("renders it, and points the reference at the document it renders", async () => {
    const response = await supertest(app).get("/api/docs");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.text).toContain("/api/openapi.yaml");
  });
});
